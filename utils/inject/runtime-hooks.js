// Runtime hooks injected by the FE 8.x patch automation.
//
// This file is prepended to server/index.js right after its `const port = ...;`
// line, and the resulting file becomes resources/app/out/main.js. It runs in the
// Electron main process before the original application code.
//
// It handles name resolution only: FE 8.x rewrites its API endpoints to
// http://api.getfiddler.be:<port> and http://identity.getfiddler.be:<port>, and
// those hostnames have real public DNS records. Both the renderer and the .NET
// backend must therefore be redirected to the local server.
//
//   * renderer -> Chromium host-resolver-rules switch
//   * backend  -> system hosts entries (the .NET process resolves DNS itself,
//                 so the Chromium switch has no effect on it)
//
// Frontend response signature verification is neutralised at build time by
// patching the Angular bundle, see the "Patch FE 8.x frontend signature checks"
// workflow step.

try {
  const __feElectron = require('electron')
  const __feApp = __feElectron.app

  // 1) Renderer side: keep the .be API hosts on the loopback interface.
  try {
    if (__feApp && __feApp.commandLine && __feApp.commandLine.appendSwitch) {
      const __feRules = 'MAP api.getfiddler.be 127.0.0.1, MAP identity.getfiddler.be 127.0.0.1'
      __feApp.commandLine.appendSwitch('host-resolver-rules', __feRules)
      console.info('[fe-patch] host-resolver-rules:', __feRules)
    }
  } catch (e) {
    console.error('[fe-patch] host-resolver-rules failed:', e)
  }

  // 2) Backend side: the .NET process only sees the system hosts file.
  //
  //    Writing that file needs administrator rights, and requesting elevation
  //    from inside the app would pop up UAC and a console window on every
  //    launch. Instead only write when the current process can already do it
  //    (the app was started elevated); otherwise point at the bundled
  //    install-hosts.cmd, which the user runs once.
  try {
    const __fs = require('fs')
    const __path = require('path')
    const __domains = ['api.getfiddler.be', 'identity.getfiddler.be']
    const __hostsPath = process.platform === 'win32'
      ? __path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
      : '/etc/hosts'

    let __content = ''
    try {
      __content = __fs.readFileSync(__hostsPath, 'utf8')
    } catch (e) {
      __content = ''
    }

    const __missing = __domains.filter(function (domain) {
      return !__content.split(/\r?\n/).some(function (line) {
        const fields = line.split('#')[0].trim().split(/\s+/)
        return fields.length > 1 && fields[0] === '127.0.0.1' && fields[1].toLowerCase() === domain
      })
    })

    if (!__missing.length) {
      console.info('[fe-patch] hosts entries already present')
    } else {
      let __written = false
      try {
        __fs.appendFileSync(
          __hostsPath,
          '\n# fiddler-everywhere-enhance\n' +
            __missing.map(function (domain) { return '127.0.0.1 ' + domain }).join('\n') + '\n'
        )
        __written = true
        console.info('[fe-patch] hosts patched')
      } catch (e) {
        console.error('[fe-patch] hosts not writable, run install-hosts.cmd once: ' + __missing.join(', '))
      }

      if (!__written) {
        try {
          __feElectron.dialog.showMessageBoxSync({
            type: 'warning',
            title: 'Fiddler Everywhere patch',
            message: 'The local API host entries are missing.',
            detail:
              'Sign in and the main window require these entries in the system hosts file:\n\n' +
              __missing.map(function (domain) { return '127.0.0.1 ' + domain }).join('\n') +
              '\n\nRight-click install-hosts.cmd in the application folder, choose ' +
              '"Run as administrator", then restart Fiddler Everywhere.',
            buttons: ['OK'],
          })
        } catch (e) { /* dialogs may be unavailable during startup */ }
      }
    }
  } catch (e) {
    console.error('[fe-patch] hosts setup failed:', e)
  }

  // 3) Diagnostics: record what the local server answers so a stuck start can be
  //    diagnosed from a single file. Responses without a Signature header mean
  //    the mock file tree has no template for that endpoint, which leaves the
  //    UI waiting on data it never receives.
  try {
    const __dFs = require('fs')
    const __dOs = require('os')
    const __dPath = require('path')
    const __electron = __feElectron

    let __logPath = ''
    try {
      __logPath = __dPath.join(__electron.app.getPath('userData'), 'fe-patch.log')
    } catch (e) {
      __logPath = __dPath.join(__dOs.tmpdir(), 'fe-patch.log')
    }

    const __log = function (message) {
      const line = '[' + new Date().toISOString() + '] ' + message + '\n'
      try {
        __dFs.appendFileSync(__logPath, line)
      } catch (e) { /* logging must never break startup */ }
      console.info('[fe-patch] ' + message)
    }

    __log('log opened: ' + __logPath)
    __log('version: ' + (__electron.app.getVersion ? __electron.app.getVersion() : 'unknown'))
    __log('execPath: ' + process.execPath)

    const __http = require('http')
    const __origCreateServer = __http.createServer
    __http.createServer = function () {
      const server = __origCreateServer.apply(this, arguments)
      server.on('request', function (req, res) {
        const target = req.method + ' ' + (req.headers.host || '') + (req.url || '')

        // Only the mock server answers with the literal body "not implement";
        // legitimate non JSON replies (the OAuth HTML pages, favicon, or the
        // app's own callback listener) must not be reported as misses.
        const __origEnd = res.end
        res.end = function (chunk) {
          try {
            const body = chunk ? String(chunk) : ''
            if (body === 'not implement') {
              __log('[endpoint-miss] ' + target)
            }
          } catch (e) { /* ignore */ }
          return __origEnd.apply(this, arguments)
        }
      })
      return server
    }

    // Mirror the backend process output into the diagnostics log. The backend
    // reports authorization and signature problems on stderr, and those lines
    // never reach the application log file.
    const __cp = require('child_process')
    const __origSpawn = __cp.spawn
    __cp.spawn = function (command) {
      const child = __origSpawn.apply(this, arguments)
      try {
        if (String(command).indexOf('Fiddler.WebUi') !== -1) {
          __log('[spawn] ' + command + ' ' + JSON.stringify([].slice.call(arguments[1] || [])))
          if (child.stdout) {
            child.stdout.on('data', function (chunk) {
              __log('[backend:out] ' + String(chunk).trim())
            })
          }
          if (child.stderr) {
            child.stderr.on('data', function (chunk) {
              __log('[backend:err] ' + String(chunk).trim())
            })
          }
          child.on('exit', function (code, signal) {
            __log('[backend:exit] code=' + code + ' signal=' + signal)
          })
        }
      } catch (e) { /* ignore */ }
      return child
    }

    // Mirror renderer console output. The Angular app logs most of its state
    // through its own logger, but load and bootstrap failures only reach the
    // DevTools console, which is not available while the UI is stuck.
    try {
      __electron.app.on('web-contents-created', function (_event, contents) {
        contents.on('console-message', function () {
          // Electron < 36 passes positional args, newer versions an object.
          const args = [].slice.call(arguments)
          let level = ''
          let message = ''
          if (args[1] && typeof args[1] === 'object') {
            level = args[1].level || ''
            message = args[1].message || ''
          } else {
            level = args[1]
            message = args[2]
          }
          if (!message) return
          if (String(level) === 'error' || String(level) === 'warning' || String(level) === '3' || String(level) === '2') {
            __log('[renderer:' + level + '] ' + String(message).substring(0, 800))
          }
        })
        contents.on('did-fail-load', function (_e, code, description, url, isMainFrame) {
          __log('[renderer:did-fail-load] ' + code + ' ' + description + ' ' + url + ' mainFrame=' + isMainFrame)
        })
        contents.on('render-process-gone', function (_e, details) {
          __log('[renderer:gone] ' + JSON.stringify(details))
        })
        contents.on('preload-error', function (_e, preloadPath, error) {
          __log('[renderer:preload-error] ' + preloadPath + ' ' + (error && error.message))
        })
      })
    } catch (e) { /* ignore */ }
  } catch (e) {
    console.error('[fe-patch] diagnostics setup failed:', e)
  }
} catch (e) {
  console.error('[fe-patch] runtime hooks failed:', e)
}

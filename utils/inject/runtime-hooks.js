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
  try {
    const __fs = require('fs')
    const __os = require('os')
    const __path = require('path')
    const __cp = require('child_process')
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
    } else if (process.platform === 'win32') {
      // Writing the hosts file requires elevation. Generate a script and run it
      // through UAC once; later launches see the entries and stay silent.
      const __scriptPath = __path.join(__os.tmpdir(), 'fe-patch-hosts.ps1')
      const __psLines = __missing.map(function (domain) {
        return "'127.0.0.1 " + domain + "'"
      })
      __fs.writeFileSync(
        __scriptPath,
        "$ErrorActionPreference='Stop'\r\n" +
          "Add-Content -LiteralPath '" + __hostsPath + "' -Encoding ascii -Value (" +
          "[Environment]::NewLine + '# fiddler-everywhere-enhance' + " +
          __psLines.join(' + [Environment]::NewLine + ') +
          " + [Environment]::NewLine)\r\n",
        'utf8'
      )
      try {
        __cp.execFileSync(
          'powershell',
          ['-NoProfile', '-Command',
            "Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden " +
            "-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','" + __scriptPath + "')"],
          { stdio: 'ignore' }
        )
        console.info('[fe-patch] hosts patched (elevated)')
      } catch (e) {
        console.error('[fe-patch] hosts elevation failed; add manually: ' + __missing.join(', '))
      }
    } else {
      try {
        __fs.appendFileSync(
          __hostsPath,
          '\n# fiddler-everywhere-enhance\n' +
            __missing.map(function (domain) { return '127.0.0.1 ' + domain }).join('\n') + '\n'
        )
        console.info('[fe-patch] hosts patched')
      } catch (e) {
        console.error('[fe-patch] hosts patch failed (needs root); add manually: ' + __missing.join(', '))
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
        res.on('finish', function () {
          try {
            const signed = !!(res.getHeader && res.getHeader('signature'))
            if (!signed && res.statusCode === 200) {
              __log('[endpoint-miss] ' + target + ' -> no signature (no template)')
            }
          } catch (e) { /* ignore */ }
        })
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
  } catch (e) {
    console.error('[fe-patch] diagnostics setup failed:', e)
  }
} catch (e) {
  console.error('[fe-patch] runtime hooks failed:', e)
}

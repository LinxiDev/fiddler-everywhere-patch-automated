// Runtime hooks injected by the FE 8.x patch automation.
//
// This file is prepended to server/index.js right after its `const port = ...;`
// line, and the resulting file becomes resources/app/out/main.js. It runs in the
// Electron main process before the original application code.
//
// Two responsibilities:
//
// 1. Name resolution. FE 8.x rewrites its API endpoints to
//    http://api.getfiddler.be:<port> and http://identity.getfiddler.be:<port>,
//    and those hostnames have real public DNS records.
//      * renderer -> Chromium host-resolver-rules switch
//      * backend  -> system hosts entries (the .NET process resolves DNS
//                    itself, so the Chromium switch has no effect on it)
//    The hosts entries cannot be written without administrator rights, and
//    requesting elevation from inside the app pops up UAC plus a console window
//    on every launch. They are written when the process already can, otherwise
//    the user is told exactly what to do and the app exits instead of hanging on
//    the loading screen forever.
//
// 2. Diagnostics. Everything the local server answers without a template, plus
//    the backend process output, plus renderer errors, is appended to
//    <userData>/fe-patch.log. Without it a stuck start is completely silent.
//
// Frontend response signature verification is neutralised at build time by
// patching the Angular bundle, see the "Patch FE 8.x frontend signature checks"
// workflow step.
;(function () {
  var electron = require('electron')
  var app = electron.app

  // ---------------------------------------------------------------- logging --
  var logPath = ''
  try {
    logPath = require('path').join(app.getPath('userData'), 'fe-patch.log')
  } catch (e) {
    logPath = require('path').join(require('os').tmpdir(), 'fe-patch.log')
  }

  function log(message) {
    try {
      require('fs').appendFileSync(logPath, '[' + new Date().toISOString() + '] ' + message + '\n')
    } catch (e) { /* logging must never break startup */ }
    console.info('[fe-patch] ' + message)
  }

  log('log opened: ' + logPath)
  try {
    log('version: ' + (app.getVersion ? app.getVersion() : 'unknown'))
  } catch (e) { /* ignore */ }
  log('execPath: ' + process.execPath)

  // ------------------------------------------------------------- renderer DNS --
  try {
    if (app.commandLine && typeof app.commandLine.appendSwitch === 'function') {
      var rules = 'MAP api.getfiddler.be 127.0.0.1, MAP identity.getfiddler.be 127.0.0.1'
      app.commandLine.appendSwitch('host-resolver-rules', rules)
      log('host-resolver-rules: ' + rules)
    }
  } catch (e) {
    log('host-resolver-rules failed: ' + e)
  }

  // --------------------------------------------------------------- hosts file --
  var HOSTS_DOMAINS = ['api.getfiddler.be', 'identity.getfiddler.be']
  var hostsPath = process.platform === 'win32'
    ? require('path').join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
    : '/etc/hosts'

  function missingHostsEntries() {
    var content = ''
    try {
      content = require('fs').readFileSync(hostsPath, 'utf8')
    } catch (e) {
      content = ''
    }
    return HOSTS_DOMAINS.filter(function (domain) {
      return !content.split(/\r?\n/).some(function (line) {
        var fields = line.split('#')[0].trim().split(/\s+/)
        return fields.length > 1 && fields[0] === '127.0.0.1' && fields[1].toLowerCase() === domain
      })
    })
  }

  // Writes the entries with the rights the current process already has. Returns
  // true on success.
  function appendHostsEntries(missing) {
    try {
      require('fs').appendFileSync(
        hostsPath,
        '\n# fiddler-everywhere-enhance\n' +
          missing.map(function (domain) { return '127.0.0.1 ' + domain }).join('\n') + '\n'
      )
      log('hosts patched automatically')
      return true
    } catch (e) {
      log('hosts not writable directly: ' + missing.join(', '))
      return false
    }
  }

  // The hosts file is managed by the 安装Hosts.bat / 卸载Hosts.bat helpers
  // shipped next to the executable. The app never asks for elevation:
  // requesting it from inside the process needs a UAC prompt, and any modal
  // dialog blocks the event loop that also serves the local API.
  function ensureHostsEntries() {
    var missing = missingHostsEntries()
    if (!missing.length) {
      log('hosts entries present')
      return Promise.resolve()
    }

    // Only write when the process already has the rights. A normal launch never
    // does, so this succeeds only when the user started the app elevated.
    if (appendHostsEntries(missing)) {
      return Promise.resolve()
    }

    log('hosts entries missing; run 安装Hosts.bat as administrator: ' +
        missing.join(', '))

    return new Promise(function (resolve) {
      electron.dialog.showMessageBox({
        type: 'warning',
        title: 'Fiddler Everywhere patch - hosts entries required',
        message: 'The hosts entries for the local API server are missing.',
        detail:
          'Signing in requires these lines in ' + hostsPath + ' :\n\n' +
          missing.map(function (domain) { return '127.0.0.1 ' + domain }).join('\n') +
          '\n\nRight-click 安装Hosts.bat in the application folder, choose ' +
          '"Run as administrator", then start Fiddler Everywhere again.',
        buttons: ['OK'],
      }).then(function () { resolve() })
        .catch(function (e) {
          log('hosts dialog failed: ' + e)
          resolve()
        })
    })
  }

  // Dialogs need the app to be ready, so run the check there rather than inline.
  try {
    app.whenReady().then(ensureHostsEntries).catch(function (e) {
      log('hosts check failed: ' + e)
    })
  } catch (e) {
    log('hosts check scheduling failed: ' + e)
  }

  // ------------------------------------------------------------------- resolver --
  //
  // The hosts file being correct is not the same thing as the OS resolver
  // returning loopback for these names. The .NET backend uses the operating
  // system resolver, so verify what it will actually get and log it either way.
  //
  // Also log proxy related environment variables: a system or environment proxy
  // makes the backend send its API calls elsewhere and the sign-in then hangs
  // until the 100 second HttpClient timeout, with no server-side trace.
  function verifyResolution() {
    var dns = require('dns')
    var pending = HOSTS_DOMAINS.length
    var notLoopback = []

    function checkDone() {
      pending -= 1
      if (pending > 0) return
      if (!notLoopback.length) return

      var list = notLoopback.map(function (item) {
        return item.domain + ' -> ' + item.addresses
      }).join('\n')

      log('[dns:error] resolver does not return loopback for: ' + list)

      // If the hosts entries are missing, that is the real cause and the hosts
      // dialog already explains it. Only a stale cache is worth its own dialog.
      if (missingHostsEntries().length) {
        log('[dns:error] hosts entries are missing; see the hosts hint above')
        return
      }

      // The hosts file looks correct but the resolver still returns a public
      // address, so the .NET backend cannot reach the local server and its
      // sign-in hangs until the 100 second HttpClient timeout. The usual cause
      // is a stale resolver cache: flush it and start over.
      // Asynchronous on purpose: a modal dialog on the main process also blocks
      // the local API server that lives on the same event loop.
      try {
        electron.dialog.showMessageBox({
          type: 'warning',
          title: 'Fiddler Everywhere patch - DNS cache',
          message: 'These names still resolve to a public address.',
          detail: list + '\n\n' +
            'The hosts file looks correct, so the resolver cache is probably stale.\n\n' +
            'Run this in an administrator command prompt, then start the app again:\n\n' +
            '    ipconfig /flushdns\n\n' +
            'Verify with:  ping api.getfiddler.be   (must answer from 127.0.0.1)',
          buttons: ['OK'],
        }).catch(function () { /* ignore */ })
      } catch (e) { /* dialogs may be unavailable */ }
    }

    HOSTS_DOMAINS.forEach(function (domain) {
      try {
        dns.lookup(domain, { all: true }, function (err, addresses) {
          if (err) {
            log('[dns] ' + domain + ' -> ERROR ' + err.code)
            notLoopback.push({ domain: domain, addresses: 'lookup error ' + err.code })
            checkDone()
            return
          }
          var list = (addresses || []).map(function (a) { return a.address }).join(', ')
          var local = (addresses || []).some(function (a) {
            return a.address === '127.0.0.1' || a.address === '::1'
          })
          log('[dns] ' + domain + ' -> ' + list + (local ? ' (loopback ok)' : ' (NOT loopback)'))
          if (!local) {
            notLoopback.push({ domain: domain, addresses: list || '(empty)' })
          }
          checkDone()
        })
      } catch (e) {
        log('[dns] ' + domain + ' -> lookup failed ' + e)
        notLoopback.push({ domain: domain, addresses: 'lookup failed' })
        checkDone()
      }
    })

    ;['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
      'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'].forEach(function (name) {
      if (process.env[name]) {
        log('[proxy] ' + name + '=' + process.env[name])
      }
    })
  }

  try {
    app.whenReady().then(verifyResolution).catch(function (e) {
      log('resolver check failed: ' + e)
    })
  } catch (e) {
    log('resolver check scheduling failed: ' + e)
  }

  // ------------------------------------------------------------ server tracing --
  //
  // The local API server is created by the injected server/index.js. Three
  // additions here, all of which a stuck sign-in depends on:
  //
  //  * CORS. The mock server sends no Access-Control-* headers at all. The
  //    renderer runs from a file:// origin, so a stricter Chromium build (or a
  //    proxy in front of it) rejects the response and the app reports
  //    "0 Unknown Error" / "Failed to fetch" instead of anything useful.
  //  * Private Network Access. Chromium blocks requests from a public origin to
  //    loopback unless the response opts in.
  //  * Visibility. A failed bind (the usual EADDRINUSE on 5678) previously left
  //    no trace anywhere, which looks exactly like a network outage.
  try {
    var http = require('http')
    var originalCreateServer = http.createServer

    http.createServer = function (handler) {
      var args = [].slice.call(arguments)

      if (typeof handler === 'function') {
        args[0] = function (req, res) {
          var target = req.method + ' ' + (req.headers.host || '') + (req.url || '')

          try {
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
            res.setHeader('Access-Control-Allow-Headers', '*')
            res.setHeader('Access-Control-Expose-Headers', '*')
            res.setHeader('Access-Control-Allow-Private-Network', 'true')
            res.setHeader('Access-Control-Max-Age', '600')
          } catch (e) { /* headers may already be sent */ }

          // Answer preflight directly; the mock handler only knows GET/POST.
          if (req.method === 'OPTIONS') {
            log('[cors] preflight ' + target)
            res.statusCode = 204
            res.end()
            return
          }

          var originalEnd = res.end
          res.end = function (chunk) {
            try {
              var body = chunk ? String(chunk) : ''

              // Only the mock server replies with this literal string.
              if (body === 'not implement') {
                log('[endpoint-miss] ' + target)
              }

              // Record every exchange, including the successful ones. A hung
              // sign-in is otherwise indistinguishable from a request that
              // never reached this server at all.
              var signed = !!(res.getHeader && res.getHeader('signature'))
              log(
                '[req] ' + target + ' -> ' + res.statusCode +
                (signed ? ' signed' : ' unsigned') +
                ' ' + body.length + 'B'
              )
            } catch (e) { /* ignore */ }
            return originalEnd.apply(this, arguments)
          }

          return handler.call(this, req, res)
        }
      }

      var server = originalCreateServer.apply(this, args)

      server.on('listening', function () {
        try {
          var addr = server.address()
          log('[server] listening on ' + (addr && addr.address) + ':' + (addr && addr.port))
        } catch (e) { /* ignore */ }
      })

      server.on('error', function (err) {
        var code = (err && err.code) || 'unknown'
        log('[server:error] ' + code + ' ' + (err && err.message))
        if (code === 'EADDRINUSE') {
          log('[server:error] the local API port is already in use; every ' +
              'api.getfiddler.* request will fail with status 0')
          try {
            electron.dialog.showMessageBox({
              type: 'error',
              title: 'Fiddler Everywhere patch - port already in use',
              message: 'The local API server could not start because the port is already in use.',
              detail:
                (err && err.message ? err.message + '\n\n' : '') +
                'Close other Fiddler Everywhere instances (or the application using ' +
                'this port), then start the app again.\n\n' +
                'Tip: use a different port by running the workflow with another ' +
                '"patch-server-port" value.',
              buttons: ['OK'],
            }).catch(function () { /* ignore */ })
          } catch (e) { /* dialogs may be unavailable */ }
        }
      })

      return server
    }
  } catch (e) {
    log('server tracing failed: ' + e)
  }

  // ------------------------------------------------------------ backend tracing --
  try {
    var cp = require('child_process')
    var originalSpawn = cp.spawn
    cp.spawn = function (command) {
      var child = originalSpawn.apply(this, arguments)
      try {
        if (String(command).indexOf('Fiddler.WebUi') !== -1) {
          log('[spawn] ' + command + ' ' + JSON.stringify([].slice.call(arguments[1] || [])))
          if (child.stdout) {
            child.stdout.on('data', function (chunk) {
              log('[backend:out] ' + String(chunk).trim())
            })
          }
          if (child.stderr) {
            child.stderr.on('data', function (chunk) {
              log('[backend:err] ' + String(chunk).trim())
            })
          }
          child.on('exit', function (code, signal) {
            log('[backend:exit] code=' + code + ' signal=' + signal)
          })
        }
      } catch (e) { /* ignore */ }
      return child
    }
  } catch (e) {
    log('backend tracing failed: ' + e)
  }

  // ----------------------------------------------------------- renderer tracing --
  try {
    app.on('web-contents-created', function (_event, contents) {
      contents.on('console-message', function () {
        // Electron < 36 passes positional args, newer versions an object.
        var args = [].slice.call(arguments)
        var level = ''
        var message = ''
        if (args[1] && typeof args[1] === 'object') {
          level = args[1].level || ''
          message = args[1].message || ''
        } else {
          level = args[1]
          message = args[2]
        }
        if (!message) return
        var text = String(level)
        if (text === 'error' || text === 'warning' || text === '3' || text === '2') {
          log('[renderer:' + level + '] ' + String(message).substring(0, 800))
        }
      })
      contents.on('did-fail-load', function (_e, code, description, url, isMainFrame) {
        log('[renderer:did-fail-load] ' + code + ' ' + description + ' ' + url + ' mainFrame=' + isMainFrame)
      })
      contents.on('render-process-gone', function (_e, details) {
        log('[renderer:gone] ' + JSON.stringify(details))
      })
      contents.on('preload-error', function (_e, preloadPath, error) {
        log('[renderer:preload-error] ' + preloadPath + ' ' + (error && error.message))
      })
    })
  } catch (e) {
    log('renderer tracing failed: ' + e)
  }
})();

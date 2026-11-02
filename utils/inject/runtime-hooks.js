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
} catch (e) {
  console.error('[fe-patch] runtime hooks failed:', e)
}

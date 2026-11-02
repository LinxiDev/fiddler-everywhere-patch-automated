// Runtime hooks injected by the FE 8.x patch automation.
//
// This file is prepended to server/index.js right after its `const port = ...;`
// line, and the resulting file becomes resources/app/out/main.js. It runs in the
// Electron main process before the original application code.
//
// It fixes three things that a portable (installer-less) FE 8.x package needs:
//
// 1. Chromium DNS override so the renderer reaches the local API server.
// 2. System hosts entries so the .NET backend process does the same. The backend
//    resolves DNS through the OS, so the Chromium switch above cannot help it.
// 3. A bypass for the baked-in ECDSA public key whitelist of the Angular bundle.

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

  // 3) Angular bundle whitelist bypass.
  //
  //    The renderer verifies every signed response against three hardcoded ECDSA
  //    public keys, while server/index.js signs them with a key generated at
  //    runtime, so the lookup always fails. All P-256 SPKI keys start with
  //    30 59 30 13 (48, 89, 48, 19); treat any such key as whitelisted.
  const __somePatch = '(function(){try{' +
    'if(Array.prototype.__feSomePatch)return;' +
    'var original=Array.prototype.some;' +
    'Array.prototype.some=function(callback,thisArg){' +
    'return original.call(this,function(value,index,array){' +
    'try{if(value&&value.length>=4&&value[0]===48&&value[1]===89&&value[2]===48&&value[3]===19)return true}catch(e){}' +
    'return callback.call(thisArg,value,index,array)' +
    '},thisArg)};' +
    'Array.prototype.__feSomePatch=true;' +
    '}catch(e){}})();'

  try {
    __feApp.on('web-contents-created', function (_event, contents) {
      // dom-ready fires before the Angular bootstrap runs the first signed
      // request; did-finish-load is kept as a fallback (the patch is idempotent).
      contents.on('dom-ready', function () {
        contents.executeJavaScript(__somePatch).catch(function () {})
      })
      contents.on('did-finish-load', function () {
        contents.executeJavaScript(__somePatch).catch(function () {})
      })
    })
    console.info('[fe-patch] frontend signature whitelist bypass registered')
  } catch (e) {
    console.error('[fe-patch] whitelist bypass failed:', e)
  }
} catch (e) {
  console.error('[fe-patch] runtime hooks failed:', e)
}

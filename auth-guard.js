(function() {
    var HASH = 'd387d8f016a1e8dd471de17fd837ce101676156ab7d2ec1e395a67d46f3472b0';
    var AUTH_KEY = 'cheese_duke_auth';
    var hideStyle = document.createElement('style');
    hideStyle.id = 'auth-guard-hide';
    hideStyle.textContent = 'body { display: none !important; }';
    document.head.appendChild(hideStyle);
    function sha256(msg) {
          return crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg)).then(function(buf) {
                  return Array.from(new Uint8Array(buf)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
          });
    }
    function showPage() {
          var hide = document.getElementById('auth-guard-hide');
          if (hide) hide.remove();
          var overlay = document.getElementById('auth-guard-overlay');
          if (overlay) overlay.remove();
    }
    function showLoginOverlay() {
          var hide = document.getElementById('auth-guard-hide');
          if (hide) hide.textContent = 'body > *:not(#auth-guard-overlay) { display: none !important; } body { display: block !important; margin: 0; }';
          var overlay = document.createElement('div');
          overlay.id = 'auth-guard-overlay';
          overlay.innerHTML = '<div style="position:fixed;top:0;left:0;width:100%;height:100%;background:linear-gradient(135deg,#0a0f1a 0%,#1a2332 100%);display:flex;align-items:center;justify-content:center;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,sans-serif;"><div style="text-align:center;padding:40px;"><div style="font-size:40px;margin-bottom:12px;">&#x1F512;</div><div style="font-size:26px;font-weight:800;color:#f59e0b;margin-bottom:6px;">起士公爵</div><div style="font-size:13px;color:#64748b;margin-bottom:36px;">此頁面需要密碼才能存取</div><div style="display:flex;gap:12px;justify-content:center;align-items:center;"><input type="password" id="auth-guard-pwd" placeholder="請輸入密碼" autofocus style="padding:12px 20px;font-size:16px;border:2px solid #334155;border-radius:10px;outline:none;width:220px;background:#1e293b;color:#e2e8f0;font-family:inherit;"><button id="auth-guard-btn" style="padding:12px 28px;font-size:16px;background:#f59e0b;color:#0a0f1a;border:none;border-radius:10px;cursor:pointer;font-weight:700;font-family:inherit;">進入</button></div><div id="auth-guard-err" style="color:#ef4444;font-size:13px;margin-top:16px;min-height:20px;"></div></div></div>';
          function insertOverlay() {
                  if (document.body) {
                            document.body.appendChild(overlay);
                            var pwdInput = document.getElementById('auth-guard-pwd');
                            var errDiv = document.getElementById('auth-guard-err');
                            function doCheck() {
                                        sha256(pwdInput.value).then(function(hash) {
                                                      if (hash === HASH) { sessionStorage.setItem(AUTH_KEY, 'true'); showPage(); }
                                                      else { errDiv.textContent = '密碼錯誤，請重新輸入'; pwdInput.value = ''; pwdInput.focus(); }
                                        });
                            }
                            pwdInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') doCheck(); });
                            document.getElementById('auth-guard-btn').addEventListener('click', doCheck);
                            pwdInput.focus();
                  } else {
                            document.addEventListener('DOMContentLoaded', function() { insertOverlay(); });
                  }
          }
          insertOverlay();
    }
    if (sessionStorage.getItem(AUTH_KEY) === 'true') {
          document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', showPage) : showPage();
    } else {
          document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', function() { showLoginOverlay(); }) : showLoginOverlay();
    }
})();

'use strict';
(function () {
  function $(id) { return document.getElementById(id); }
  function send(msg) { return chrome.runtime.sendMessage(msg).catch(function () { return null; }); }

  function render() {
    send({ type: 'ug:getStatus' }).then(function (d) {
      if (!d || !d.status) { $('status').textContent = 'The guard service worker did not respond.'; return; }
      var s = d.status;
      $('status').textContent = (s.locked ? 'Locked.' : 'Unlocked for about ' + Math.ceil(s.remainingMs / 60000) + ' min.') +
        ' Unlocks left today: ' + s.unlocksLeft + '.';
      $('start').disabled = !s.canUnlock;
      $('lock').disabled = s.locked;
    });
  }

  $('start').addEventListener('click', function () {
    send({ type: 'ug:openInterstitial', reason: 'feed', next: 'https://www.youtube.com/' }).then(function () { window.close(); });
  });
  $('lock').addEventListener('click', function () { send({ type: 'ug:lockNow' }).then(render); });
  $('settings').addEventListener('click', function (e) { e.preventDefault(); chrome.runtime.openOptionsPage(); window.close(); });
  render();
})();

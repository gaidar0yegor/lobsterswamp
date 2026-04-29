/* ═══ Font Loader ═══
   Promotes a preloaded stylesheet to an active stylesheet without inline
   onload handlers. CSP-friendly replacement for onload="this.rel='stylesheet'".

   Why swap synchronously: the preload has already kicked off the fetch.
   Changing rel="preload" -> rel="stylesheet" makes the browser apply the
   (already in-flight or cached) CSS immediately. Waiting for a 'load' event
   is racy — if the preload completed before this script ran, the event
   never fires and the browser logs "preloaded but not used". */
(function(){
  var link = document.getElementById('font-preload');
  if(!link) return;
  if(link.rel === 'stylesheet') return;
  link.rel = 'stylesheet';
})();

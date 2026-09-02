(async () => {
  const version = '20260901-8';
  const parts = ['app.part00.txt', 'app.part01.txt', 'app.part02.txt', 'app.part03.txt', 'app.part04.txt', 'app.part05.txt', 'app.part06.txt'];
  const code = (await Promise.all(parts.map(async (name) => {
    const url = new URL(name, import.meta.url);
    url.searchParams.set('v', version);
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Failed to load ${name}: ${response.status}`);
    return response.text();
  }))).join('');
  new Function(code + '\n//# sourceURL=accompaniment-studio-runtime.js')();
})().catch((error) => {
  console.error(error);
  document.body.insertAdjacentHTML('beforeend', `<div style="position:fixed;left:12px;right:12px;bottom:12px;padding:12px;background:#7f1d1d;color:#fff;border-radius:10px;z-index:99999">Accompaniment Studio failed to initialize. Refresh the page or check your connection.</div>`);
});

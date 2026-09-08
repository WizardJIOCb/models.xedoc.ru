const route = location.pathname.replace(/\/$/, '') || '/';
if (route === '/' || /^\/(gallery|profiles|profile|model)(\/|$)/.test(route)) {
  const { mountCommunityPage } = await import('./community.js');
  await mountCommunityPage();
} else {
  await import('./main.js');
}

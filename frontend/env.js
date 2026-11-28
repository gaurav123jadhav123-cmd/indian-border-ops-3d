// Optional runtime settings. Leave both empty for local play (phone or PC): the page then talks to
// the backend on port 4000 and the game server on port 5000 of the SAME machine it was opened from.
//
// For a hosted game put the public URLs here, for example:
//   window.__BORDER_OPS_ENV__ = {
//     API_URL: 'https://border-ops-api.example.com',
//     GAME_SERVER_URL: 'https://border-ops-play.example.com'
//   };
window.__BORDER_OPS_ENV__ = { API_URL: '', GAME_SERVER_URL: '' };

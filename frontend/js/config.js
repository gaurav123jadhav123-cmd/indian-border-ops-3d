// Update these URLs when deploying Backend & Game Server to Railway, Render, or a VPS.
export const CONFIG = {
  BACKEND_URL: window.location.origin.includes('localhost')
    ? 'http://localhost:4000'
    : window.location.origin,
  GAME_SERVER_URL: window.location.hostname === 'localhost'
    ? 'http://localhost:5000'
    : `${window.location.protocol}//${window.location.hostname}:5000`
};

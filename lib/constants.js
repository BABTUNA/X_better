/**
 * Shared constants for X Followers Search & Export
 */
const XFE = {
  // Message types for window.postMessage between MAIN <-> ISOLATED worlds
  MSG_PREFIX: 'xfe_',
  MSG_USERS_CAPTURED: 'xfe_users_captured',
  MSG_PAGE_TYPE: 'xfe_page_type',

  // URL patterns
  URL_FOLLOWERS: /^https:\/\/(x|twitter)\.com\/([^/]+)\/followers\/?$/,
  URL_FOLLOWING: /^https:\/\/(x|twitter)\.com\/([^/]+)\/following\/?$/,
  URL_FOLLOWER_PAGE: /^https:\/\/(x|twitter)\.com\/([^/]+)\/(followers|following)\/?$/,

  // GraphQL endpoint patterns
  GQL_FOLLOWERS: /\/graphql\/[^/]+\/Followers/,
  GQL_FOLLOWING: /\/graphql\/[^/]+\/Following/,

  // DOM selectors (data-testid based for stability)
  SEL_PRIMARY_COLUMN: '[data-testid="primaryColumn"]',
  SEL_USER_CELL: '[data-testid="UserCell"]',
  SEL_CELL_INNER: '[data-testid="cellInnerDiv"]',
  SEL_REGION: 'section[role="region"]',

  // Timing
  URL_POLL_INTERVAL: 500,
  SCROLL_INTERVAL: 1500,
  SCROLL_TIMEOUT: 5 * 60 * 1000,
  SCROLL_STALE_LIMIT: 5,

  // CSS class prefix
  CSS_PREFIX: 'xfe-',
};

// Make available in both MAIN and ISOLATED worlds
if (typeof window !== 'undefined') {
  window.__XFE_CONSTANTS = XFE;
}

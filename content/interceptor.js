/**
 * MAIN world content script - intercepts fetch/XHR to capture follower data
 * Runs at document_start before X's own scripts
 */
(function () {
  'use strict';

  const GQL_FOLLOWERS = /\/graphql\/[^/]+\/(Followers|BlueVerifiedFollowers)/;
  const GQL_FOLLOWING = /\/graphql\/[^/]+\/Following/;
  const GQL_SEARCH = /\/graphql\/[^/]+\/SearchTimeline/;
  const MSG_USERS_CAPTURED = 'xfe_users_captured';
  const MSG_TWEETS_CAPTURED = 'xfe_tweets_captured';

  /**
   * Extract user objects from GraphQL response.
   * Tries multiple known response shapes to be resilient to API changes.
   */
  function extractUsers(json) {
    const users = [];
    try {
      const instructions =
        json?.data?.user?.result?.timeline?.timeline?.instructions || [];

      for (const instruction of instructions) {
        const entries = instruction.entries || [];
        for (const entry of entries) {
          try {
            const userResult =
              entry?.content?.itemContent?.user_results?.result;
            if (!userResult) continue;

            const legacy = userResult.legacy || {};
            const core = userResult.core || {};

            // core now holds name/screen_name/created_at directly (X API change)
            const screenName =
              core.screen_name || legacy.screen_name || userResult.screen_name || '';
            const name =
              core.name || legacy.name || userResult.name || '';

            if (!screenName) continue;

            users.push({
              id: userResult.rest_id || '',
              name: name,
              screenName: screenName,
              description: legacy.description || userResult.profile_bio?.description || '',
              followersCount: legacy.followers_count ?? '',
              followingCount: legacy.friends_count ?? '',
              verified: userResult.is_blue_verified || false,
              profileImageUrl:
                legacy.profile_image_url_https || userResult.avatar?.image_url || '',
              createdAt: core.created_at || legacy.created_at || '',
            });
          } catch (e) {
            // Skip individual entry parse errors
          }
        }
      }
    } catch (e) {
      // Silently fail on top-level parse errors
    }

    // Also try to find users via a recursive search if the standard path found nothing
    if (users.length === 0) {
      findUsersRecursive(json, users, new Set());
    }

    return users;
  }

  /**
   * Recursively search the response JSON for objects that look like user results.
   * Handles cases where X changes the nesting structure.
   */
  function findUsersRecursive(obj, users, seen, depth) {
    if (!obj || typeof obj !== 'object' || (depth || 0) > 12) return;

    // Detect a user-like object: has rest_id and screen_name in core or legacy
    const screenName = obj.core?.screen_name || obj.legacy?.screen_name;
    if (obj.rest_id && screenName) {
      if (!seen.has(obj.rest_id)) {
        seen.add(obj.rest_id);
        const legacy = obj.legacy || {};
        const core = obj.core || {};
        users.push({
          id: obj.rest_id,
          name: core.name || legacy.name || '',
          screenName: screenName,
          description: legacy.description || obj.profile_bio?.description || '',
          followersCount: legacy.followers_count ?? '',
          followingCount: legacy.friends_count ?? '',
          verified: obj.is_blue_verified || false,
          profileImageUrl: legacy.profile_image_url_https || obj.avatar?.image_url || '',
          createdAt: core.created_at || legacy.created_at || '',
        });
      }
      return; // Don't recurse into a found user
    }

    if (Array.isArray(obj)) {
      for (const item of obj) {
        findUsersRecursive(item, users, seen, (depth || 0) + 1);
      }
    } else {
      for (const key of Object.keys(obj)) {
        findUsersRecursive(obj[key], users, seen, (depth || 0) + 1);
      }
    }
  }

  /**
   * Extract tweet objects from SearchTimeline GraphQL response.
   */
  function extractTweets(json) {
    const tweets = [];
    const seen = new Set();
    try {
      const instructions =
        json?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions || [];

      for (const instruction of instructions) {
        const entries = instruction.entries || [];
        for (const entry of entries) {
          try {
            const itemContent = entry?.content?.itemContent;
            if (!itemContent) continue;
            const tweetResult = itemContent.tweet_results?.result;
            if (!tweetResult) continue;
            const tweet = parseTweetResult(tweetResult, seen);
            if (tweet) tweets.push(tweet);
          } catch (e) {
            // Skip individual entry parse errors
          }
        }
      }
    } catch (e) {
      // Silently fail on top-level parse errors
    }

    // Recursive fallback if standard path found nothing
    if (tweets.length === 0) {
      findTweetsRecursive(json, tweets, seen);
    }

    return tweets;
  }

  function parseTweetResult(result, seen) {
    // Handle tweet with tombstone or unavailable
    if (result.__typename === 'TweetTombstone') return null;
    // Handle TweetWithVisibilityResults wrapper
    if (result.tweet) result = result.tweet;

    const tweetId = result.rest_id;
    if (!tweetId || seen.has(tweetId)) return null;
    seen.add(tweetId);

    const legacy = result.legacy || {};
    const core = result.core?.user_results?.result || {};
    const coreLegacy = core.legacy || {};
    const coreCore = core.core || {};

    const authorHandle =
      coreCore.screen_name || coreLegacy.screen_name || core.screen_name || '';
    const authorName =
      coreCore.name || coreLegacy.name || core.name || '';

    // Long tweets use note_tweet
    const noteTweetText =
      result.note_tweet?.note_tweet_results?.result?.text || '';
    const text = noteTweetText || legacy.full_text || '';

    return {
      tweetId,
      authorName,
      authorHandle,
      text,
      createdAt: legacy.created_at || '',
      likeCount: legacy.favorite_count ?? 0,
      retweetCount: legacy.retweet_count ?? 0,
      replyCount: legacy.reply_count ?? 0,
      quoteCount: legacy.quote_count ?? 0,
      viewCount: result.views?.count ?? '',
      tweetUrl: authorHandle
        ? `https://x.com/${authorHandle}/status/${tweetId}`
        : '',
    };
  }

  function postUsers(users) {
    if (users.length > 0) {
      window.postMessage(
        { type: MSG_USERS_CAPTURED, users: users },
        '*'
      );
    }
  }

  function isFollowerEndpoint(url) {
    return GQL_FOLLOWERS.test(url) || GQL_FOLLOWING.test(url);
  }

  function isSearchEndpoint(url) {
    return GQL_SEARCH.test(url);
  }

  // --- Patch window.fetch ---
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const request = args[0];
    const url = typeof request === 'string' ? request : request?.url || '';

    if (!isFollowerEndpoint(url)) {
      return originalFetch.apply(this, args);
    }

    return originalFetch.apply(this, args).then(async (response) => {
      try {
        const clone = response.clone();
        const json = await clone.json();
        const users = extractUsers(json);
        postUsers(users);
      } catch (e) {
        // Ignore parse failures
      }
      return response;
    });
  };

  // --- Patch XMLHttpRequest as fallback ---
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._xfeUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this._xfeUrl && isFollowerEndpoint(this._xfeUrl)) {
      this.addEventListener('load', function () {
        try {
          const json = JSON.parse(this.responseText);
          const users = extractUsers(json);
          postUsers(users);
        } catch (e) {
          // Ignore
        }
      });
    }
    return originalSend.apply(this, args);
  };
})();

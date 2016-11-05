'use strict';

var os = require('os');
var url = require('url');
var fs = require('fs');
var qs = require('querystring');

var request = require('request');

var ResourceError = require('../error/ResourceError');
var authc = require('../authc');
var packageJson = require('../../package.json');
var utils = require('../utils');

var USER_AGENT_VALUE = 'stormpath-sdk-node/' + packageJson.version + ' node/' + process.versions.node + ' ' + os.platform() + '/' + os.release();

var dev_app_hrefs = [
  'https://api.stormpath.com/v1/applications/1W7aBXYKFqPgbf6Xzjevee',
  'https://api.stormpath.com/v1/applications/4wQzH1nzkWUYd50nV3A32Q'
];

var cached_urls = [
  /^\/applications\/[0-9a-z]+$/i,
  /^\/applications\/[0-9a-z]+\/accountStoreMappings$/i,
  /^\/oAuthPolicies\/[0-9a-z]+$/i,
  /^\/organizations\/[0-9a-z]+$/i,
  /^\/directories\/[0-9a-z]+$/i,
  /^\/directories\/[0-9a-z]+\/provider$/i,
  /^\/passwordPolicies\/[0-9a-z]+$/i,
  /^\/passwordPolicies\/[0-9a-z]+\/strength$/i
];
function isCachedURI(uri) {
  var is_cached = false;
  cached_urls.forEach(function(re) {
    if (re.test(uri))
      is_cached = true;
  });
  return is_cached;
}

var is_dev = dev_app_hrefs.indexOf(process.env.STORMPATH_APPLICATION_HREF) > -1;

/**
 * @class
 *
 * @private
 *
 * @description
 *
 * An HTTP request abstraction.  The DataStore uses this to make HTTP requests.
 *
 * @param {Object} options Construction options
 * @param {String} [options.baseUrl=https://api.stormpath.com/v1]
 * @param {BasicRequestAuthenticator|Sauthc1RequestAuthenticator} options.requestAuthenticator
 * @param {Object} [options.headers] A map of headers to apply to all requets.
 */
function RequestExecutor(options) {

  options = options || {};

  this.baseUrl = options.baseUrl || 'https://api.stormpath.com/v1';

  this.requestAuthenticator = authc.getAuthenticator(options);

  options.headers = options.headers || {};
  options.json = true;

  this.options = options;
  
  var cache_json;
  if (is_dev) {
    cache_json = tryFile('service-deps/stormpath-auto-cache.json');
    if (!cache_json)
      cache_json = tryFile('deps/stormpath-auto-cache.json');
  }
  else {
    cache_json = tryFile('service-deps/stormpath-dev-cache.json');
    if (!cache_json)
      cache_json = tryFile('deps/stormpath-dev-cache.json');
    if (!cache_json)
      throw new Error('Unable to find [service-]deps/stormpath-dev-cache.json in: ' + process.cwd());
  }

  if (cache_json) {
    try {
      this.csnw_cache = JSON.parse(cache_json);
    }
    catch(err) {
      throw new Error('Unable to parse JSON in stormpath-dev-cache.json: ' + cache_json);
    }
  }
  else if (is_dev) {
    this.csnw_cache = {};
  }
  else {
    throw new Error('stormpath-dev-cache.json file not found');
  }
}
utils.inherits(RequestExecutor, Object);

function tryFile(path) {
  try {
    return fs.readFileSync(path, {encoding: 'utf8'});
  }
  catch(err) {}
}

/**
 * Executes an HTTP request based on the request object passed in. Request object properties:
 * @param {Object} request
 * @param {String} request.uri a fully qualified URL, e.g. `https://api.stormpath.com/v1/tenants/current`.
 * @param {String} [request.method=GET] E.g. 'GET', 'PUT', 'POST', or 'DELETE'
 * @param {Object} [request.query] JSON object to convert to a query string.
 * @param {Object} [request.body] JSON object to use as the request body.
 * @param {Function} callback The callback to invoke when the request returns.
 * Called with (networkErr, resourceResponseBody).
 */
RequestExecutor.prototype.execute = function executeRequest(req, callback) {
  if (!req) {
    throw new Error('Request argument is required.');
  }
  if (!req.uri) {
    throw new Error('request.uri field is required.');
  }

  // Don't override the defaults: ensure that the options arg is request-specific.
  var options = utils.shallowCopy(this.options, {});

  req.method = req.method || 'GET';

  options.method = req.method;
  options.baseUrl = this.baseUrl;
  options.uri = url.parse(req.uri.replace(options.baseUrl,'')).path;
  options.headers['User-Agent'] = options.userAgent ? options.userAgent + ' ' + USER_AGENT_VALUE : USER_AGENT_VALUE;

  if (req.query) {
    options.qs = req.query;
  }

  if (req.body && req.body.form){
    options.form = req.body.form;
  } else if (req.body) {
    options.body = req.body;
    options.json = true; // All Stormpath resources are JSON
  }

  this.requestAuthenticator.authenticate(options);

  // if this GET request is in our JSON cache, return it (avoids 48 API hits every startup)
  var cache_key = options.uri;
  if (options.qs && Object.keys(options.qs).length)
    cache_key += '?' + qs.stringify(options.qs);
  
  if (cache_key in this.csnw_cache && options.method == 'GET')
    return callback(null, this.csnw_cache[cache_key]);

  // STORMPATH API hit tracking, so we can know *why* we're going over the limits
  /*var method_url = options.method + ' ' + options.uri;

  if (!global.hits)
    global.hits = {};
  if (global.hits[method_url])
    global.hits[method_url]++;
  else
    global.hits[method_url] = 1;
  
  if (!global.id)
    global.id = Math.round(Math.random() * 1000);
  
  var hit_count = 0;
  for (var id in global.hits)
    hit_count += global.hits[id];*/

  // raise awareness of how frequently we're hitting the Stormpath API
  console.log('STORMPATH API HIT: ' + options.uri);
  var cache = this.csnw_cache;
  request(options, function onRequestResult(err, response, body) {
    var responseContext = this;

    if (err) {
      var wrapper = new Error('Unable to execute http request ' + req.method + ' ' + req.uri + ': ' + err.message);
      wrapper.inner = err;
      return callback(wrapper, null);
    }

    if (response.statusCode > 399) {
      return callback(new ResourceError(body || {status:response.statusCode}, {url: responseContext.href, method: req.method}), null);
    }

    if (response.statusCode === 201){
      Object.defineProperty(body, '_isNew', { value: true });
    }

    if (response.statusCode === 202 && !body){
      callback(null, { accepted:true });
    }else{
      if (is_dev && options.method == 'GET' && !cache[cache_key] && isCachedURI(options.uri)) {
        cache[cache_key] = body;
        fs.writeFileSync('service-deps/stormpath-auto-cache.json', JSON.stringify(cache));
      }

      callback(null, body);
    }
  });
};

module.exports = RequestExecutor;

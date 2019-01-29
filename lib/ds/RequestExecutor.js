'use strict';

var os = require('os');
var url = require('url');
var fs = require('fs');

var request = require('request');

var ResourceError = require('../error/ResourceError');
var authc = require('../authc');
var packageJson = require('../../package.json');
var utils = require('../utils');

var USER_AGENT_VALUE = 'stormpath-sdk-node/' + packageJson.version + ' node/' + process.versions.node + ' ' + os.platform() + '/' + os.release();

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

  this.baseUrl = options.org.replace(/\/$/,'') + '/api/v1/';

  this.requestAuthenticator = authc.getAuthenticator(options);

  options.headers = options.headers || {};
  options.json = true;

  this.options = options;

  var cache_json;
  try {
    cache_json = fs.readFileSync('service-deps/stormpath-dev-cache.json', {encoding: 'utf8'});
  }
  catch(err) {
    try {
      cache_json = fs.readFileSync('deps/stormpath-dev-cache.json', {encoding: 'utf8'});
    }
    catch(err) {
      throw new Error('Unable to find [service-]deps/stormpath-dev-cache.json in: ' + process.cwd());
    }
  }
  try {
    this.csnw_cache = JSON.parse(cache_json);
  }
  catch(err) {
    throw new Error('Unable to parse JSON in stormpath-dev-cache.json: ' + cache_json);
  }
}
utils.inherits(RequestExecutor, Object);

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
RequestExecutor.prototype.execute = function executeRequest(req, callback, num_times) {
  if (!callback) {
    throw new Error('Argument \'callback\' required. Unable to execute request.');
  }

  if (!req) {
    return callback(new Error('Request argument is required.'));
  }

  if (!req.uri) {
    return callback(new Error('request.uri field is required.'));
  }

  if (!num_times)
    num_times = 1;

  // Don't override the defaults: ensure that the options arg is request-specific.
  var options = utils.shallowCopy(this.options, {});

  var parsedUrl = url.parse(req.uri.replace(options.baseUrl,''));

  req.method = req.method || 'GET';

  options.method = req.method;
  options.baseUrl = parsedUrl.path === parsedUrl.href ? this.baseUrl : '';
  options.uri = parsedUrl.path === parsedUrl.href ? parsedUrl.path : parsedUrl.href;
  options.headers['User-Agent'] = options.userAgent ? options.userAgent + ' ' + USER_AGENT_VALUE : USER_AGENT_VALUE;

  if (req.query) {
    options.qs = req.query;
  }

  if (req.body && req.body.form){
    options.form = req.body.form;
  } else if (req.body) {
    options.body = req.body;
    delete options.body.href;
    options.json = true; // All Stormpath resources are JSON
  }

  this.requestAuthenticator.authenticate(options);

  // if this GET request is in our JSON cache, return it (avoids 48 API hits every startup)
  if (options.uri in this.csnw_cache && options.method == 'GET')
    return callback(null, this.csnw_cache[options.uri]);

  /*
  // STORMPATH API hit tracking, so we can know why we're going over the limits
  var method_url = options.method + ' ' + options.uri;

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
    hit_count += global.hits[id];

  console.log('(process ' + global.id + ') STORMPATH API HIT ' + hit_count + ': ' + method_url);
  */

  console.log('STORMPATH API HIT: ' + options.uri);
  var req_executor = this;
  if (req.method == 'GET')
    options.timeout = 20 * 1000;
  request(options, function onRequestResult(err, response, body) {
    var responseContext = this;

    if (err) {
      console.log(`HTTP request failed (try #${num_times}) ${req.method} ${req.uri}: ${err.message} (retrying)`);
      // retry failed GET requests every five seconds, up to five times
      // NOTE: this is only for true HTTP failures, not 400-level/500-level error responses
      if (num_times < (5) && req.method == 'GET') {
        return setTimeout(function() {
          req_executor.execute(req, callback, num_times + 1);
        }, 5000);
      }
      else {
        var wrapper = new Error('Unable to execute http request ' + req.method + ' ' + req.uri + ': ' + err.message);
        wrapper.inner = err;
        return callback(wrapper, null);
      }
    }

    if (response.statusCode > 399) {
      if (body) {
        body.status = response.statusCode;
      }
      return callback(new ResourceError(body || {status:response.statusCode}, {url: responseContext.href, method: req.method}), null);
    }

    if (response.statusCode === 201){
      Object.defineProperty(body, '_isNew', { value: true });
    }

    if (response.statusCode === 202 && !body){
      callback(null, { accepted:true });
    }else{
      callback(null, body);
    }
  });
};

module.exports = RequestExecutor;

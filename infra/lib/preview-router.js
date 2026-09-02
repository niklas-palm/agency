// CloudFront Function (viewer request) for PR previews: map the host's first label to a
// key prefix in the previews bucket, so one distribution serves every open PR.
//
//   123.example.com/            -> /123/index.html
//   123.example.com/assets/x.js -> /123/assets/x.js
//
// This is the whole routing rule for previews, which is why it lives in its own file with
// tests (preview-router.test.ts) rather than inline in the stack: get it wrong and one PR's
// preview serves another PR's bundle.
//
// The CloudFront Functions runtime is ES5.1 - no template literals, no arrow functions, no
// String#endsWith - and it runs on every request, so keep it allocation-light.
function handler(event) {
  var request = event.request;
  var host = request.headers.host ? request.headers.host.value : "";
  var dot = host.indexOf(".");
  var label = dot === -1 ? host : host.substring(0, dot);
  // A preview is always a PR NUMBER. Anything else - the distribution's own
  // *.cloudfront.net name, a probe for some other subdomain that the wildcard DNS record
  // now answers for - is refused here, instead of becoming a confusing S3 AccessDenied
  // page for a key that was never going to exist.
  if (!/^[0-9]+$/.test(label)) {
    return {
      statusCode: 404,
      statusDescription: "Not Found",
      headers: { "content-type": { value: "text/plain" } },
      body: "No preview here. Previews are served at <pull-request-number>." + host.substring(dot + 1),
    };
  }
  var uri = request.uri;
  if (uri.charAt(uri.length - 1) === "/") uri = uri + "index.html";
  request.uri = "/" + label + uri;
  return request;
}

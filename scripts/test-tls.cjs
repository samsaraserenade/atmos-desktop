'use strict';
/**
 * A self-signed certificate and key for local HTTPS test servers (unit
 * tests and the end-to-end checks of atmos.fetch()). For tests only: it
 * names api.test.example, other.test.example, elsewhere.example,
 * api.github.com (so the extension template can be run against it) and
 * geocoding-api.open-meteo.com (the Location service's search), is valid
 * for a hundred years, and is trusted only where a test passes it as a CA.
 */
const cert = `-----BEGIN CERTIFICATE-----
MIICAjCCAamgAwIBAgIUffkEdTGJget+bfG7s8lqfv1dQ3swCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRQXRtb3MgdGVzdCBzZXJ2ZXIwIBcNMjYxMDA1MjEwNTEzWhgP
MjEyNjA5MTEyMTA1MTNaMBwxGjAYBgNVBAMMEUF0bW9zIHRlc3Qgc2VydmVyMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAENr4tNkZUtkpIsibodRwnzybYsu77ddf9
sR303lHqA+tDuI6Eiw2tYGGfmlafrVLP4wjjqXrl1WjQyFcuWx7/wKOBxjCBwzAd
BgNVHQ4EFgQUALrwNT37dwp6BonFQCoc5tpUkdcwHwYDVR0jBBgwFoAUALrwNT37
dwp6BonFQCoc5tpUkdcwcAYDVR0RBGkwZ4IQYXBpLnRlc3QuZXhhbXBsZYISb3Ro
ZXIudGVzdC5leGFtcGxlghFlbHNld2hlcmUuZXhhbXBsZYIOYXBpLmdpdGh1Yi5j
b22CHGdlb2NvZGluZy1hcGkub3Blbi1tZXRlby5jb20wDwYDVR0TAQH/BAUwAwEB
/zAKBggqhkjOPQQDAgNHADBEAiBgBNFrvtHVvwy4/NEEbrIr7p9XWXumGM0PO2cF
mhGI3gIgWFuAw6OnshH8QN3lHow6AnezvkNdYyfFKEso7o+cPkk=
-----END CERTIFICATE-----
`;
const key = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQghS0qGYI1LE2224hW
V3iW+TBQiDqUi7urshkcuViKlmOhRANCAAQ2vi02RlS2SkiyJuh1HCfPJtiy7vt1
1/2xHfTeUeoD60O4joSLDa1gYZ+aVp+tUs/jCOOpeuXVaNDIVy5bHv/A
-----END PRIVATE KEY-----
`;

module.exports = { cert, key };

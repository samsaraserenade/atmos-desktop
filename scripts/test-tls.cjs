'use strict';
/**
 * A self-signed certificate and key for local HTTPS test servers (unit
 * tests and the end-to-end checks of atmos.fetch()). For tests only: it
 * names api.test.example, other.test.example, elsewhere.example and
 * api.github.com (so the extension template can be run against it), is
 * valid until 2126, and is trusted only where a test passes it as a CA.
 */
const cert = `-----BEGIN CERTIFICATE-----
MIIB5jCCAYugAwIBAgIUdsYt9aNBxuq3ds9FbE4IHSgi4dswCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRQXRtb3MgdGVzdCBzZXJ2ZXIwIBcNMjYwOTI5MTQxNDM5WhgP
MjEyNjA5MDUxNDE0MzlaMBwxGjAYBgNVBAMMEUF0bW9zIHRlc3Qgc2VydmVyMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEZpFoSszojKdNsm7RjkNWTAQKbaxmbCy+
ad4p+E6sbKqLLg9vnvtehjoMxZkXiiladQYhKYshBtzLWKnIDWM9FqOBqDCBpTAd
BgNVHQ4EFgQUK+iPvLJSBB+hUymcoJXQ2nztGsEwHwYDVR0jBBgwFoAUK+iPvLJS
BB+hUymcoJXQ2nztGsEwUgYDVR0RBEswSYIQYXBpLnRlc3QuZXhhbXBsZYISb3Ro
ZXIudGVzdC5leGFtcGxlghFlbHNld2hlcmUuZXhhbXBsZYIOYXBpLmdpdGh1Yi5j
b20wDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNJADBGAiEAha1/hW0+vW82
CiYZDaxE5WJXH07p2PVjk5SvFnmVWeQCIQCM45EbyXHEnC6d94t+wIlgmOsmyOs5
85b5I49A9cbylA==
-----END CERTIFICATE-----
`;
const key = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg20qfKG1jUx6ZD8Gf
PxGzekDKPYHKDYplon4R/dfpTCihRANCAARmkWhKzOiMp02ybtGOQ1ZMBAptrGZs
LL5p3in4TqxsqosuD2+e+16GOgzFmReKKVp1BiEpiyEG3MtYqcgNYz0W
-----END PRIVATE KEY-----
`;

module.exports = { cert, key };

# Atmos Extension Exception, version 1.0

Additional permission under section 7 of the GNU General Public License,
version 3 ("GPLv3").

Copyright (C) 2026 hashy

This exception is an additional permission granted by the copyright holder
of Atmos under section 7 of the GPLv3. It applies to every part of Atmos
licensed under the GPLv3, which is all of Atmos except the folders listed in
[NOTICE](NOTICE) as having a licence of their own.

## 1. Definitions

- **"Atmos"** means the program distributed with this exception: Atmos Core
  and the plugins and services distributed with it.
- **"Extension Interface"** means the ways Atmos provides for an extension
  to work with it, as documented in `ATMOS_CORE_INTEGRATION.md`: the Atmos
  SDK (`core/js/sdk/`); the `extension.json` manifest; the messages
  exchanged between an extension's frames and Atmos Core; and the
  capabilities of Atmos's own plugins and services that an extension
  reaches through the SDK (its `invoke`, `call`, `library` and event
  functions, and similar).
- **"Independent Extension"** means a plugin or service that
  1. is not based on Atmos's code, apart from the Atmos SDK and code
     examples in Atmos's documentation; and
  2. works with Atmos only through the Extension Interface: it does not
     load, include, patch or depend on Atmos's internal modules (anything
     outside the SDK) by other means.

## 2. Permission

You may create, run, copy and distribute Independent Extensions, alone or
together with Atmos (in a package, a package source or an installer), under
terms of your choice, including non-free terms. Running an Independent
Extension in Atmos, or using Atmos's plugins and services through the
Extension Interface, does not by itself make the extension a work based on
Atmos for the purposes of the GPLv3.

## 3. What stays under the GPLv3

This permission does not change the licence of Atmos itself. In
particular, the following remain under the GPLv3:

- Atmos, and any modified version of Atmos Core or of the plugins and
  services distributed with it, however it is distributed;
- code copied from Atmos into an extension (other than the MIT-licensed
  Atmos SDK and documentation examples);
- an extension that does not meet the definition of an Independent
  Extension.

## 4. Modified versions of Atmos

If you distribute a modified version of Atmos, you may keep this exception
for your version or remove it, as section 7 of the GPLv3 allows. If you
remove it, extensions for your version cannot rely on it.

---

This exception is written in plain terms for extension authors. It has
not yet been reviewed by a lawyer; if you are relying on it for a
commercial extension, get your own advice.

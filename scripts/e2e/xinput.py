#!/usr/bin/env python3
# Real X input (XTest) for browser.cjs and keys.cjs: clicks and keys go to whatever is
# under the pointer or has the keyboard, as they would from the OS, which
# is how they reach a web page's <webview>. Needs python3-xlib. One command
# a line on stdin; "ok" (or "error ...") a line on stdout.
#   click X Y [BUTTON]   move X Y   key COMBO (e.g. ctrl+l, alt+Left, Tab)   type TEXT
#   keydown KEY   keyup KEY   (one key held: alt, ctrl, shift or a key name)
import sys, time
from Xlib import X, XK, display
from Xlib.ext import xtest

d = display.Display()
MODS = {'ctrl': 'Control_L', 'shift': 'Shift_L', 'alt': 'Alt_L', 'super': 'Super_L'}

def keycode(name):
    sym = XK.string_to_keysym(name)
    if sym == 0 and len(name) == 1:
        sym = ord(name)
    code = d.keysym_to_keycode(sym)
    if not code:
        raise ValueError('no key ' + name)
    return code

def press(code, down):
    xtest.fake_input(d, X.KeyPress if down else X.KeyRelease, code)

def combo(text):
    parts = text.split('+')
    mods = [keycode(MODS[p]) for p in parts[:-1]]
    key = parts[-1]
    shifted = len(key) == 1 and (key.isupper() or key in '~!@#$%^&*()_+{}|:"<>?')
    names = {']': 'bracketright', '[': 'bracketleft', '\\': 'backslash', ' ': 'space', '-': 'minus', '=': 'equal', '+': 'plus', '.': 'period', '/': 'slash', ':': 'colon'}
    code = keycode(names.get(key, key))
    if shifted:
        mods.append(keycode('Shift_L'))
    for m in mods: press(m, True)
    press(code, True); press(code, False)
    for m in reversed(mods): press(m, False)
    d.sync()

for line in sys.stdin:
    cmd, _, rest = line.rstrip('\n').partition(' ')
    try:
        if cmd in ('click', 'move', 'down', 'up'):
            args = rest.split()
            x, y = int(float(args[0])), int(float(args[1]))
            button = int(args[2]) if len(args) > 2 else 1
            xtest.fake_input(d, X.MotionNotify, x=x, y=y); d.sync()
            if cmd == 'click':
                time.sleep(0.03)
                xtest.fake_input(d, X.ButtonPress, button); d.sync(); time.sleep(0.04)
                xtest.fake_input(d, X.ButtonRelease, button); d.sync()
            elif cmd == 'down':
                xtest.fake_input(d, X.ButtonPress, button); d.sync()
            elif cmd == 'up':
                xtest.fake_input(d, X.ButtonRelease, button); d.sync()
        elif cmd == 'key':
            combo(rest)
        elif cmd in ('keydown', 'keyup'):
            press(keycode(MODS.get(rest, rest)), cmd == 'keydown'); d.sync()
        elif cmd == 'type':
            for ch in rest:
                combo(ch)
                time.sleep(0.02)
        print('ok', flush=True)
    except Exception as e:
        print('error', e, flush=True)

# Manual test — assistant beside the page

Covers `src/main/assistant/assistants.ts`, `TabManager.openAssistant`, the Ctrl+Shift+L accelerator,
the toolbar button and the Settings group.

## What this is

A website in a pane. Slash opens claude.ai (or another assistant) in the second split pane, in the
normal session, and the user signs in the way they always do — so a Claude Pro or Max subscription
works, with no API key.

There is **no integration**. Slash does not read the page and does not send anything to the
assistant. A test that "passes" by finding page text in the assistant's input is a failure.

## 1 — It opens, and it is signed in

1. Ctrl+Shift+L on any page.
2. **Expect:** the page splits; claude.ai loads in the right pane; focus stays in the left pane.
3. Sign in. **Expect:** the normal claude.ai sign-in — no key field anywhere in Slash.
4. Ask it something. **Expect:** it answers on your subscription.
5. Close Slash entirely and reopen. Ctrl+Shift+L. **Expect:** still signed in — the pane uses the
   ordinary persistent session, so cookies survive.

## 2 — It is a toggle, and it does not duplicate

1. With the assistant docked, press Ctrl+Shift+L. **Expect:** the split ends; the assistant tab
   stays open in the strip.
2. Press it again. **Expect:** the **same** tab docks — not a second one, and any conversation in
   progress is still there.
3. Open claude.ai yourself in a normal tab, then press Ctrl+Shift+L from a different tab.
   **Expect:** your existing tab is docked rather than a new one created.

## 3 — The honest failure

1. Narrow the window below roughly 650px.
2. Press Ctrl+Shift+L, or the toolbar button.
3. **Expect:** a short notice in the toolbar reading that the window is too narrow for two pages.
   **Must not:** appear to do nothing.

## 4 — Choosing a different one

1. Settings → Browsing → **Assistant** → ChatGPT.
2. Ctrl+Shift+L. **Expect:** chatgpt.com docks.
3. Choose **Another address…** and type `http://example.com`.
4. Ctrl+Shift+L. **Expect:** refused with a reason — plaintext is not accepted for a pane holding a
   signed-in session.
5. Type `https://example.com`. **Expect:** it docks.

## 5 — The toolbar button can be hidden, not disabled

1. Settings → Appearance → Toolbar → hide **Assistant beside page**.
2. **Expect:** the button goes; **Ctrl+Shift+L still works**, and the menu entry remains.

## 6 — Nothing leaves the page

1. Open a page with distinctive text. Dock the assistant.
2. **Expect:** the assistant's input is empty. Nothing about the page has been sent.
3. Settings → Assistant. **Expect:** copy saying exactly that, and pointing at the separate switch
   for the feature that does send page content.

## Regression

`docs/testing/split-view.md` — this is split view with one pane chosen for you, so every split
behaviour (drag divider, swap, stack, closing a pane) must still hold with the assistant docked.

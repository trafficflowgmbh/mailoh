"use client";

/**
 * ── P2 — THE SPY-PIXEL BLOCKER'S CONSENT HALF, AND THE FIRST CONSUMER `GET /img` HAS EVER
 *    HAD ────────────────────────────────────────────────────────────────────────────────
 *
 * `MessageBody.tsx` has blocked every remote reference since O11b, and its header states the
 * one thing it deliberately does NOT do: *"It does not fetch a blocked image after consent,
 * and the consent button is therefore absent rather than dead."* This module is that consent
 * path. It is the whole of what was missing, and it is small on purpose — the sanitizer,
 * the frame CSP and the SSRF gate are all somewhere else, already built and already watched.
 *
 * ── WHY A PROXY AT ALL, RATHER THAN JUST LETTING THE `<img>` LOAD ───────────────────────
 *
 * Because the reader's IP address is the thing being protected, and "load images" in every
 * other mail client hands it to the sender. A remote image in bulk mail is a request to a
 * host the sender chose, from the reader's own machine, carrying their address, their
 * approximate location, their user agent and the fact that they opened this message at this
 * minute. Routing it through `GET /img` makes that request OURS: `PrivacyService.proxyImage`
 * fetches server-side through a port whose signature takes ONLY a url — there is no
 * parameter through which a client header could travel, which is a structural guarantee
 * rather than a remembered one.
 *
 * ── THE URL IS SAME-ORIGIN, AND THAT IS LOAD-BEARING IN TWO PLACES ──────────────────────
 *
 * `frameCsp(true)` admits `img-src data: 'self'` and nothing else — there is no policy under
 * which the message frame may name a sender's host — and the app's own policy
 * (`security-headers.ts`) is `img-src 'self' data: blob:`. A `srcdoc` document inherits the
 * embedder's policy container, so what is enforced is the INTERSECTION, and `'self'` on both
 * sides means exactly one host may serve a consented image: this one. `/api/*` is a Next
 * rewrite onto `api.ohmail.app` (`next.config.mjs`), so the browser only ever talks to its
 * own origin and the host-only `tf_session` cookie rides along on the subresource GET —
 * which is what authenticates the proxy. A cross-origin API url would fail BOTH the CSP and
 * the cookie, silently, and look like "images just don't work".
 *
 * The url is built ABSOLUTE against `location.origin` rather than left root-relative. A
 * relative url in a `srcdoc` document resolves against the PARENT's base url, which is the
 * behaviour we want and is also the kind of inherited subtlety that changes under a `<base>`
 * somebody adds later. Absolute costs nothing and depends on nothing.
 *
 * ── CONSENT IS AWAITED, NOT ASSUMED ─────────────────────────────────────────────────────
 *
 * The optimistic shape — flip locally, POST in the background — is wrong here and the reason
 * is specific rather than stylistic: the local flag decides what THIS render fetches, and the
 * server flag decides what the NEXT one does. Flipping locally on a POST that then fails
 * gives a reader images now and no images after a reload, with nothing said in between. So
 * the click awaits the write, and a refusal is reported and loads nothing.
 */

import { useCallback, useMemo, useState } from "react";
import { API_BASE, apiConfigured, messageOf, privacy } from "../api-client";

/**
 * Everything a rendered message needs in order to offer "Show images" — or ABSENT, which is
 * a real answer and not an oversight.
 *
 * `undefined` means this client cannot proxy an image: `?demo=1` (fixtures, zero network,
 * invariants #6 and #8), the desktop shell, and any test that mounts a view without an API.
 * `MessageBody` renders NO BUTTON for it rather than a dead one — `MessageBodyProps.imageProxy`
 * says so in as many words. The same rule `AttachmentsChrome` follows, for the same reason:
 * a control over a capability nothing can serve is worse than no control.
 */
export interface RemoteImagesChrome {
  /**
   * How to reach a remote image named by THIS message. Curried by message id because the
   * proxy is account- AND message-scoped server-side (`requireOwnedMessage`, a cross-account
   * id is a 404), so the id is not decoration — it is the authorisation.
   */
  proxyFor: (messageId: string) => (url: string) => string;
  /** Has the reader consented in THIS session? Ored with the stored flag by the caller. */
  consented: (messageId: string) => boolean;
  /** The reader pressed "Show images". Awaits the server, then admits the images. */
  consent: (messageId: string) => void;
}

/**
 * `GET /img?mid=…&u=…` for one image, as an absolute same-origin url.
 *
 * Exported and pure so the property that matters can be asserted directly rather than
 * inferred from a rendered attribute: **the sender's host never appears in the request's
 * ORIGIN, only in its query**. A test that only read the `src` string would pass on
 * `https://evil.example/x.png` too.
 *
 * `origin` is a parameter for the same reason `createEngine` takes its env: it lets a test
 * drive the real function instead of a copy of it.
 */
export function imageProxyUrl(
  base: string,
  origin: string,
  messageId: string,
  url: string,
): string {
  const u = new URL(`${base}/img`, origin);
  u.searchParams.set("mid", messageId);
  u.searchParams.set("u", url);
  return u.toString();
}

export interface RemoteImagesOptions {
  /** Say why the consent could not be recorded. The server's own sentence, never a guess. */
  onFailed: (message: string) => void;
}

/**
 * The chrome, or `undefined` on a client with no server behind it.
 *
 * State is a `Set` of message ids rather than a flag on the open message: the reader sheet
 * and the Ohbox's reading column mount the same message at once, and two copies of "did they
 * consent" is how one pane loads images and the other does not.
 */
export function useRemoteImages(opts: RemoteImagesOptions): RemoteImagesChrome | undefined {
  const [allowed, setAllowed] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());

  const onFailed = opts.onFailed;

  const proxyFor = useCallback(
    (messageId: string) => (url: string) =>
      imageProxyUrl(API_BASE ?? "", window.location.origin, messageId, url),
    [],
  );

  const consented = useCallback((messageId: string) => allowed.has(messageId), [allowed]);

  const consent = useCallback(
    (messageId: string): void => {
      // One write per message. A second press while the first is in flight would spend a
      // second `cost: "work"` invocation for an idempotent flip nobody is waiting on twice.
      if (allowed.has(messageId) || pending.has(messageId)) return;
      setPending((p) => new Set(p).add(messageId));
      void (async () => {
        try {
          await privacy.loadRemote(messageId);
          setAllowed((a) => new Set(a).add(messageId));
        } catch (err) {
          // Nothing is admitted. See the header: a local flag the server did not record is a
          // message that shows images once and never again, with no explanation either time.
          onFailed(messageOf(err));
        } finally {
          setPending((p) => {
            const next = new Set(p);
            next.delete(messageId);
            return next;
          });
        }
      })();
    },
    [allowed, pending, onFailed],
  );

  return useMemo(
    () => (apiConfigured() ? { proxyFor, consented, consent } : undefined),
    [proxyFor, consented, consent],
  );
}

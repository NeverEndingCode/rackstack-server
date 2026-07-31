import { useState, useEffect, useRef, useMemo } from 'react';

import {
  TICK_MS, ANOMALY_LABELS, EVENT_REFRESH_THROTTLE_MS, CONFIG_POLL_MS,
} from './game/constants.js';
import { cardBorder, textDim, teal, amber, danger, inset } from './game/theme.js';
import { TABS } from './game/data/tabs.js';
import {
  fetchState, fetchConfig, makeActionQueue, startMinigame, finishMinigame,
  fetchEvent, setLeaderboardOptOut,
} from './game/api.js';
import { evaluate } from '@shared/state.js';
import { applyAction, EVENT_CLAIM_GRACE_MS } from '@shared/reducer.js';
import { computeMults, migrateGain, xpForLevel } from '@shared/gameRules.js';
import { goalCtx } from '@shared/goals.js';

import HeaderBar from './game/components/HeaderBar.jsx';
import StatsRow from './game/components/StatsRow.jsx';
import EventBanner from './game/components/EventBanner.jsx';
import MigrateBar from './game/components/MigrateBar.jsx';
import TabBar from './game/components/TabBar.jsx';
import RacksPanel from './game/components/RacksPanel.jsx';
import GridPanel from './game/components/GridPanel.jsx';
import OverclockPanel from './game/components/OverclockPanel.jsx';
import UpgradesPanel from './game/components/UpgradesPanel.jsx';
import SingularityPanel from './game/components/SingularityPanel.jsx';
import GoalsPanel from './game/components/GoalsPanel.jsx';
import GamesPanel from './game/components/GamesPanel.jsx';
import ColdStoragePanel from './game/components/ColdStoragePanel.jsx';
import EventPanel from './game/components/EventPanel.jsx';
import AnomalyToast from './game/components/AnomalyToast.jsx';
import RushOverlay from './game/components/minigames/RushOverlay.jsx';
import DebugOverlay from './game/components/minigames/DebugOverlay.jsx';
import MatchOverlay from './game/components/minigames/MatchOverlay.jsx';
import BalanceOverlay from './game/components/minigames/BalanceOverlay.jsx';
import ModalRoot from './game/components/modals/ModalRoot.jsx';
import ProfileView from './game/components/profile/ProfileView.jsx';

/*
  RACKSTACK - idle infrastructure tycoon
  v1.2 makes the server authoritative: `state` ({run, meta, server}) is
  fetched from /api/state on boot and kept in sync via the action queue
  (game/api.js). Every user action is applied *optimistically* to a local
  copy (via @shared/reducer.js's applyAction - the exact same function the
  server runs) for instant UI feedback, then dispatched to the server; the
  250ms tick similarly predicts production locally via @shared/state.js's
  evaluate() - again the exact function the server uses. Whenever a batch of
  queued actions is acknowledged, the local copy is thrown away and rebuilt
  from the server's canonical state plus a replay of anything dispatched
  since (see handleReconcile below). This keeps the client and server from
  ever silently diverging on the actual economy math - only display-only
  bits (active minigame overlay state, which tab is open, modals) are
  client-only state.
*/

// Live Events (v1.4): whether the player's PERSONAL window
// (state.meta.eventProgress) is currently live, and whether the event tab
// should render at all (live, OR within the 48h post-end grace period
// during which claimEventRung still accepts already-qualified rungs - see
// shared/reducer.js's EVENT_CLAIM_GRACE_MS). Pulled out as module-scope
// helpers rather than inlined at each call site so the render body and the
// activeTab-reset effect below can't drift apart on the definition.
function isEventLive(eventProgress, now) {
  return !!(eventProgress && now <= eventProgress.endsAt);
}
function isEventTabVisible(eventProgress, pendingClaims, now) {
  if (eventProgress && now <= eventProgress.endsAt + EVENT_CLAIM_GRACE_MS) return true;
  // A window force-ended early by a newer event activating keeps its own 48h
  // claim grace (spec §5.3), so the tab has to stay reachable for it even
  // when the player has no current eventProgress at all.
  return Array.isArray(pendingClaims) && pendingClaims.length > 0;
}

// Identity of the EFFECTIVE gameplay config. The stored config's `version`
// alone is not enough: activating or ending a live event changes the numbers
// the server evaluates with (its modifiers are overlaid on the baseline)
// without ever bumping that version, so a client keyed on version alone would
// keep predicting production, heat and costs from the wrong document
// indefinitely.
function configKeyOf(configRes) {
  if (!configRes) return null;
  return `${configRes.version}:${configRes.activeEventId || ''}`;
}

export default function RackStack({ user }) {
  // config: { version, data } from GET /api/config. state: canonical
  // {run, meta, server}, either fetched from GET /api/state or the result of
  // the last optimistic apply/reconcile. Both start null until boot resolves
  // (see the boot effect below) - nothing else reads them before `loaded`.
  const [config, setConfig] = useState(null);
  const [state, setState] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [modal, setModal] = useState(null);
  const [rejectToast, setRejectToast] = useState(null);
  const [activeTab, setActiveTab] = useState('racks');
  const [minigame, setMinigame] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);
  // Live Events (v1.4): the currently (or most-recently, through grace -
  // see refreshEventData below) active event's identity/ladder, and the
  // opt-out-filtered leaderboard for it. Neither is part of canonical
  // `state` - eventProgress (rungs claimed, baseline) is, and updates for
  // free on every reconcile, but the event's own name/description/theme/
  // ladder and the leaderboard are fetched separately via GET /api/event
  // (see refreshEventData).
  const [activeEvent, setActiveEvent] = useState(null);
  const [eventLeaderboard, setEventLeaderboard] = useState([]);
  // Windows force-ended early by a newer event activating, still inside their
  // own 48h claim grace: [{ event, progress }] straight from GET /api/event.
  // Unlike `activeEvent` these carry their own progress snapshot, because the
  // canonical meta.eventProgress has already moved on to the newer event.
  const [pendingClaims, setPendingClaims] = useState([]);
  // Local mirror of the display name so a successful username change (see
  // ProfileSettings) reflects in the header/profile immediately, without a
  // page reload or waiting on the next /api/me fetch (App.jsx's `user`
  // object is fetched once on boot and never re-fetched).
  const [displayName, setDisplayName] = useState(user && user.username);
  // Bumped every second purely to force a re-render for wall-clock-driven
  // displays (boost/vent/heat-cooldown countdowns, the anomaly toast) that
  // don't otherwise change React state between production ticks.
  const [, setClockTick] = useState(0);

  // configRef/stateRef mirror the state above but are updated *synchronously*
  // (not via useEffect) so rapid-fire dispatches/ticks always see the latest
  // value even within the same render pass, rather than lagging a render
  // behind the way a plain useEffect-synced ref would.
  const configRef = useRef(null);
  // configKeyOf() of whatever configRef currently holds - see the poll in the
  // heartbeat effect below.
  const configKeyRef = useRef(null);
  const lastConfigPollAtRef = useRef(0);
  const stateRef = useRef(null);
  const queueRef = useRef(null);
  const lastTickAtRef = useRef(Date.now());
  // Actions applied optimistically but not yet confirmed by a reconcile -
  // replayed on top of the server's canonical state each time one lands (see
  // handleReconcile) so in-flight optimism isn't lost/flickered away.
  const pendingActionsRef = useRef([]);
  // ids of in-flight claimAnomaly actions whose reward modal is still
  // waiting on the server's reconciled result - see claimAnomaly() and the
  // matching block in handleReconcile for why (the server rolls its own
  // reward independently of the client's optimistic prediction).
  const pendingAnomalyIdsRef = useRef(new Set());
  // _cids of in-flight claimEventRung actions still waiting on the server's
  // reconciled result for their reward modal - same mechanism as
  // pendingAnomalyIdsRef above; see claimEventRung() for why the optimistic
  // local result can't be used.
  const pendingRungClaimIdsRef = useRef(new Set());
  // Throttle gate for refreshEventData() (see its doc comment below) -
  // last Date.now() a GET /api/event fetch was kicked off from
  // handleReconcile, so a burst of reconciles (e.g. rapid IMMEDIATE claims)
  // doesn't turn into a request per reconcile.
  const lastEventFetchAtRef = useRef(0);
  // minigameRef mirrors `minigame` synchronously - like configRef/stateRef,
  // never via a plain useEffect (which would lag a render behind). Every
  // mutation of the minigame state goes through setMinigameSynced (below,
  // in the Minigames section) so the 1s heartbeat's read of
  // minigameRef.current can never observe a stale value: in particular,
  // Match's early-completion path nulls this out in the same synchronous
  // tick as the click handler, so the heartbeat's next tick can't also
  // fire a finishMinigameRound for the same (already-finishing) session -
  // see finishingRef there for the belt-and-suspenders guard too.
  const minigameRef = useRef(null);
  // sessionId of a minigame round currently mid-finish, or null - a second,
  // structural guard against double-invoking finishMinigameRound for the
  // same session (see the comment on minigameRef above for the race this
  // closes).
  const finishingRef = useRef(null);
  const debugSpawnRef = useRef(null);

  useEffect(() => () => { if (debugSpawnRef.current) clearTimeout(debugSpawnRef.current); }, []);
  useEffect(() => {
    if (!rejectToast) return undefined;
    const t = setTimeout(() => setRejectToast(null), 3000);
    return () => clearTimeout(t);
  }, [rejectToast]);

  // Stable label for the current anomaly window - chosen once per window
  // (keyed on nextAnomalyAt) rather than re-rolled every render, matching
  // the old client-rolled-event feel even though timing itself is now canon.
  const anomalyLabel = useMemo(
    () => ANOMALY_LABELS[Math.floor(Math.random() * ANOMALY_LABELS.length)],
    [state && state.server && state.server.nextAnomalyAt],
  );

  // ---------------------------------------------------------------------
  // Optimistic apply / dispatch / reconcile
  // ---------------------------------------------------------------------

  function applyLocal(action, now) {
    const { state: next, result } = applyAction(stateRef.current, action, configRef.current, now);
    stateRef.current = next;
    setState(next);
    return result;
  }

  function dispatchAction(action) {
    const now = Date.now();
    const cid = queueRef.current.dispatch(action);
    const stamped = { ...action, _cid: cid };
    const result = applyLocal(stamped, now);
    pendingActionsRef.current.push(stamped);
    return { ...result, _cid: cid };
  }

  // claimAnomaly's reward (credits-vs-boost, and the amount) is rolled by
  // shared/reducer.js's Math.random() call - independently on the client
  // (the optimistic prediction in applyLocal, above) and on the server.
  // That's a coin flip on the reward *kind* alone, so showing the
  // optimistic roll's reward would show the wrong thing to the player
  // roughly half the time. Called from handleReconcile once the
  // authoritative result for a pending claimAnomaly lands.
  function openAnomalyRewardModal(reward) {
    if (reward.kind === 'credits') {
      setModal({ type: 'eventClaim', text: `+${Math.round(reward.amount)} FLOPS collected` });
    } else {
      const seconds = Math.max(0, Math.round((reward.until - Date.now()) / 1000));
      setModal({ type: 'eventClaim', text: `×${reward.mult} output boost for ${seconds}s` });
    }
  }

  function handleReconcile(serverState, results) {
    const resultCids = new Set((results || []).map((r) => r._cid));
    pendingActionsRef.current = pendingActionsRef.current.filter((a) => !resultCids.has(a._cid));

    for (const result of results || []) {
      if (!pendingAnomalyIdsRef.current.has(result._cid)) continue;
      pendingAnomalyIdsRef.current.delete(result._cid);
      if (result.ok && result.reward) openAnomalyRewardModal(result.reward);
    }

    let rungClaimed = false;
    for (const result of results || []) {
      if (!pendingRungClaimIdsRef.current.has(result._cid)) continue;
      pendingRungClaimIdsRef.current.delete(result._cid);
      if (result.ok) { openRungRewardModal(result.reward); rungClaimed = true; }
    }

    const now = Date.now();
    let next = serverState;
    for (const action of pendingActionsRef.current) {
      next = applyAction(next, action, configRef.current, now).state;
    }

    stateRef.current = next;
    // The server's own evaluate() already caught state up to (roughly) now,
    // so restart local prediction from here rather than from `serverTime`
    // (avoids double- or under-counting a tick's worth of production across
    // any client/server clock skew).
    lastTickAtRef.current = now;
    setState(next);

    if (serverState.server.overheated) setModal({ type: 'meltdown' });

    // Live Events (v1.4): activeEvent/eventLeaderboard aren't part of
    // canonical state (see refreshEventData's own doc comment) - piggyback
    // their refresh on the cadence reconciles already happen at, throttled,
    // rather than adding a dedicated poll timer. Gated on "this player has
    // ever touched a Live Event" (either a cached identity already loaded,
    // or a live/in-grace eventProgress just landed in `next`) so a player
    // who's never interacted with one never triggers an extra request here.
    // A confirmed rung claim bypasses the throttle outright: that's exactly
    // the moment a player wants to watch their own leaderboard standing move
    // (same rationale as toggleLeaderboardOptOut).
    if (rungClaimed
      || ((activeEvent || next.meta.eventProgress)
        && now - lastEventFetchAtRef.current > EVENT_REFRESH_THROTTLE_MS)) {
      lastEventFetchAtRef.current = now;
      refreshEventData();
    }
  }

  // GET /api/event -> the player's own live-or-in-grace event identity/ladder
  // + the (opt-out-filtered, capped-at-50) leaderboard + any force-ended-but-
  // still-claimable windows. The route resolves `event` from the caller's own
  // eventProgress rather than from whatever is globally active, so it stays
  // populated through the whole 48h claim grace and a null here genuinely
  // means "this player has no window at all" - hence applying it
  // unconditionally. (It used to be applied only when non-null, because the
  // route dropped the event the instant its global status left 'active'; the
  // in-memory copy that workaround preserved died on the next page reload,
  // which is exactly how the grace period became unreachable through the UI.)
  async function refreshEventData() {
    const res = await fetchEvent();
    if (!res || res.error) return;
    setActiveEvent(res.event || null);
    setEventLeaderboard(res.leaderboard || []);
    setPendingClaims(Array.isArray(res.pendingClaims) ? res.pendingClaims : []);
  }

  // GET /api/config -> the EFFECTIVE (event-overlaid) gameplay config, i.e.
  // the exact document the server evaluates with. Applied only when its
  // identity actually changed, so the 10s poll below is a no-op in the
  // overwhelmingly common case.
  async function refreshConfig() {
    const res = await fetchConfig();
    if (!res || res.error) return;
    const key = configKeyOf(res);
    if (key === configKeyRef.current) return;
    configKeyRef.current = key;
    configRef.current = res.data;
    setConfig(res);
  }

  // If the event tab is open when the personal window + grace period both
  // lapse (player left the tab open across the boundary), fall back to
  // Racks rather than leaving them stranded on a tab TabBar is about to stop
  // rendering entirely (see the TABS filtering in the render body below).
  useEffect(() => {
    if (!state) return;
    if (activeTab === 'event' && !isEventTabVisible(state.meta.eventProgress, pendingClaims, Date.now())) {
      setActiveTab('racks');
    }
  }, [state, activeTab, pendingClaims]);

  const REJECT_MESSAGES = {
    insufficient_credits: 'Not enough FLOPS',
    cooldown_active: 'On cooldown',
    not_met: 'Not completed yet',
    session_open: 'Game already in progress',
    gone: 'Session expired',
    max_level: 'Already at max level',
    // invalid_target is a generic rejection code returned by many reducer
    // actions (buyUpgrade, migrate, singularity, claimBlock, cold-storage
    // jobs, goals, claimEventRung, setLeaderboardOptOut, ...) for a range of
    // "that target isn't valid right now" cases - bad/out-of-range index,
    // already-claimed, wrong state, etc. It is NOT event-specific, so the
    // message here has to stay generic too rather than naming any one
    // action's failure mode.
    invalid_target: 'Not available',
  };
  function showToast(text) {
    setRejectToast({ id: Date.now() + Math.random(), text });
  }
  function handleReject(result) {
    showToast(REJECT_MESSAGES[result.error] || 'Action failed');
  }

  function handleQueueError({ status }) {
    if (status === 401) {
      // Session's gone (expired/invalid cookie) and the queue has stopped
      // retrying for good - send the player back through the login gate,
      // same as the old direct-fetch 401 handling this replaces.
      window.location.reload();
    }
    // Any other batch-level failure: the queue keeps retrying with its own
    // exponential backoff; nothing else to do here.
  }

  // sendBeacon (used on pagehide/tab-hide, see game/api.js) is fire-and-
  // forget: there's no response, so no `results` array ever comes back for
  // those actions. Without this, they'd stay in pendingActionsRef forever
  // and get replayed via applyAction on top of every future server state
  // on every subsequent reconcile (handleReconcile above), indefinitely -
  // since visibilitychange->hidden fires constantly on mobile/PWA use.
  // Dropping them here (rather than waiting for a reconcile that will never
  // name their ids) breaks that cycle; if the beacon didn't actually
  // persist, the next normal reconcile just shows the pre-flush state again
  // and any real UI discrepancy self-corrects then - the tab is
  // backgrounding/closing anyway, so there's no UI left to keep predicting
  // for in the meantime.
  function handleBeaconFlush(ids) {
    const idSet = new Set(ids);
    pendingActionsRef.current = pendingActionsRef.current.filter((a) => !idSet.has(a._cid));
    // A claimAnomaly normally leaves the api.js queue instantly (it's
    // IMMEDIATE, see api.js), but a prior network outage can leave one
    // re-queued for retry - if a beacon flush sweeps it up here, its result
    // will never reconcile normally, so stop waiting on it for the reward
    // modal too (rather than leaking an entry in pendingAnomalyIdsRef that
    // never gets cleared).
    for (const id of ids) {
      pendingAnomalyIdsRef.current.delete(id);
      pendingRungClaimIdsRef.current.delete(id);
    }
  }

  if (queueRef.current === null) {
    queueRef.current = makeActionQueue({
      onReconcile: handleReconcile,
      onReject: handleReject,
      onQueueError: handleQueueError,
      onBeaconFlush: handleBeaconFlush,
    });
  }

  // Boot: fetch config + canonical state in parallel. The server is
  // authoritative for offline production (capped server-side, see
  // shared/state.js's evaluate()) - it returns the already-caught-up
  // run/meta/server plus how much was gained while away.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [configRes, stateRes] = await Promise.all([fetchConfig(), fetchState()]);
      if (cancelled) return;
      if ((configRes && configRes.error && configRes.status === 401)
        || (stateRes && stateRes.error && stateRes.status === 401)) {
        window.location.reload();
        return;
      }
      if (!configRes || configRes.error || !stateRes || stateRes.error) {
        // Network hiccup on initial boot - nothing sensible to fall back to
        // now that the server is authoritative (no local save). Stay on the
        // boot screen; a page reload will retry.
        return;
      }
      configRef.current = configRes.data;
      configKeyRef.current = configKeyOf(configRes);
      setConfig(configRes);
      const initial = { run: stateRes.run, meta: stateRes.meta, server: stateRes.server };
      stateRef.current = initial;
      setState(initial);
      lastTickAtRef.current = Date.now();
      if (stateRes.offlineGain > 1) {
        setModal({ type: 'welcome', amount: stateRes.offlineGain });
      } else if (initial.server.overheated) {
        setModal({ type: 'meltdown' });
      }
      // Live Events (v1.4): GET /api/state already carries this player's
      // claimable event identity - seed activeEvent from it directly so the
      // banner/tab don't have to wait on a second round trip. Prefer
      // `claimableEvent` (resolved from THIS player's own eventProgress, so
      // it survives the event's global end for the full 48h claim grace)
      // over `activeEvent` (the globally active row, null the instant an
      // event ends); during a live event they're the same row. Seeding from
      // `activeEvent` alone is what made the grace period unreachable after
      // any page reload. If there's anything to show, also kick a
      // refreshEventData() for the leaderboard and pending claims, which
      // /api/state doesn't carry.
      const bootEvent = stateRes.claimableEvent || stateRes.activeEvent;
      if (bootEvent) setActiveEvent(bootEvent);
      if (bootEvent || stateRes.eventProgress) {
        lastEventFetchAtRef.current = Date.now();
        refreshEventData();
      }
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // Production tick: pure prediction via @shared/state.js's evaluate(),
  // always the online path (gaps here are always well under
  // config.offline.onlineGapThresholdSec since ticks are TICK_MS apart).
  // evaluate() itself is a no-op for sub-1s gaps, so lastTickAtRef is only
  // advanced once a real (>=1s) advance actually happens - otherwise a
  // naive "reset every tick" would starve it of the 1s+ gap it needs to ever
  // produce anything.
  useEffect(() => {
    if (!loaded) return undefined;
    const iv = setInterval(() => {
      const now = Date.now();
      if (now - lastTickAtRef.current < 1000) return;
      const { state: next } = evaluate(stateRef.current, configRef.current, lastTickAtRef.current, now);
      lastTickAtRef.current = now;
      stateRef.current = next;
      setState(next);
      if (next.server.overheated) setModal({ type: 'meltdown' });
    }, TICK_MS);
    return () => clearInterval(iv);
  }, [loaded]);

  // Heartbeat (1s): forces a re-render for wall-clock displays, and ticks
  // down the active minigame's timer. Minigame sessions are server-verified
  // (Task 11): when a round's timer reaches 0 here, this redeems the
  // session by calling finishMinigameRound (below), which posts the round's
  // metric to finishMinigame(sessionId, metric) and folds the server's
  // payout back in via handleReconcile - see the "Minigames" section for
  // the full flow, including how Match's early-completion path and this
  // natural-end check are kept from double-firing the same session.
  useEffect(() => {
    if (!loaded) return undefined;
    const iv = setInterval(() => {
      setClockTick((t) => t + 1);

      // Effective-config poll. The client predicts production/heat locally
      // every 250ms from `configRef.current`, and an event
      // activating/ending swaps the document the SERVER evaluates with
      // without bumping its `version` - so there is no save-driven refetch
      // path (onConfigSaved) that covers it, and no reconcile to piggyback
      // on for a player who is idle but has the tab open. Left unrefreshed,
      // Summer Surge's shipped `heat.capacity: 4000` makes this client cross
      // ITS stale 2000 cap and pop a false meltdown modal. Cheap: GET
      // /api/config is a cached in-memory document, and refreshConfig()
      // no-ops unless (version, activeEventId) actually changed.
      const now = Date.now();
      if (now - lastConfigPollAtRef.current > CONFIG_POLL_MS) {
        lastConfigPollAtRef.current = now;
        refreshConfig();
      }

      const mg = minigameRef.current;
      if (mg && mg.timeLeft > 0 && (mg.type === 'rush' || mg.type === 'debug' || mg.type === 'match' || mg.type === 'balance')) {
        const newTimeLeft = mg.timeLeft - 1;
        if (newTimeLeft <= 0) {
          if (mg.type === 'debug' && debugSpawnRef.current) { clearTimeout(debugSpawnRef.current); debugSpawnRef.current = null; }
          setMinigameSynced(null);
          finishMinigameRound(mg);
        } else {
          setMinigameSynced((m) => (m ? { ...m, timeLeft: newTimeLeft } : m));
        }
      }
    }, 1000);
    return () => clearInterval(iv);
  }, [loaded]);

  // ---------------------------------------------------------------------
  // Economy actions - optimistic dispatch
  // ---------------------------------------------------------------------

  function buy(i, mode) { dispatchAction({ type: 'buy', lane: 'tiers', index: i, mode }); }
  function collectTier(i) { dispatchAction({ type: 'collect', index: i }); }
  function collectAll() { dispatchAction({ type: 'collectAll' }); }
  function hireManager(i) { dispatchAction({ type: 'hireManager', index: i }); }
  function buyGrid(i, mode) { dispatchAction({ type: 'buy', lane: 'grid', index: i, mode }); }
  function buyOverclock(i, mode) { dispatchAction({ type: 'buy', lane: 'overclock', index: i, mode }); }
  function ventHeat() { dispatchAction({ type: 'vent' }); }
  function buyUpgrade(u) { dispatchAction({ type: 'buyUpgrade', id: u.id }); }
  function buyShardUpgrade(u) { dispatchAction({ type: 'buyShardUpgrade', id: u.id }); }
  function claimBlock(index) { dispatchAction({ type: 'claimBlock', index }); }
  function claimAllBlocks() { dispatchAction({ type: 'claimAllBlocks' }); }
  function resetTrack() { dispatchAction({ type: 'resetTrack' }); }
  function startJob(jobType) { dispatchAction({ type: 'startJob', jobType }); }
  function cancelJob() { dispatchAction({ type: 'cancelJob' }); }
  function claimJob() { dispatchAction({ type: 'claimJob' }); }
  function buyTapeUpgrade(u) { dispatchAction({ type: 'buyTapeUpgrade', id: u.id }); }

  // claimEventRung is IMMEDIATE (see api.js) so the server round-trip lands
  // within one request rather than the full 1s auto-flush window - relevant
  // right at the edge of the 48h grace period, not just for snappy feedback.
  // Reuses the 'eventClaim' modal type claimAnomaly already opened below -
  // both are a one-line "here's what you got" toast.
  // Confirmed from the SERVER's reconciled result, correlated by _cid -
  // exactly the pattern claimAnomaly/openAnomalyRewardModal already use, and
  // for a related reason: the optimistic local apply cannot produce a
  // trustworthy result here. claimEventRung's ladder arrives via
  // `config.__claimableEvent`, a server-only per-request field that is never
  // part of the config the client holds, so the local applyAction ALWAYS
  // returned `{ok:false, error:'invalid_target'}` and this `if (result.ok)`
  // branch never once fired - no reward modal, no leaderboard refresh, while
  // every other claim in the game (claimGoal/claimBlock/claimAnomaly/
  // claimJob) confirms itself. The reward did still land via reconcile, so
  // nothing was lost; it just silently looked like nothing happened.
  // Shipping __claimableEvent to the client would duplicate the grace-window
  // eligibility rules client-side and is deliberately not done.
  function claimEventRung(index, eventId) {
    const result = dispatchAction({ type: 'claimEventRung', index, eventId });
    pendingRungClaimIdsRef.current.add(result._cid);
  }

  function openRungRewardModal(reward) {
    const r = reward || {};
    const parts = [];
    if (r.wafers) parts.push(`+${Math.round(r.wafers)} wafers`);
    if (r.tapes) parts.push(`+${Math.round(r.tapes)} tapes`);
    if (r.flops) parts.push(`+${Math.round(r.flops)} FLOPS`);
    setModal({ type: 'eventClaim', text: parts.join(' · ') || 'Reward claimed' });
  }

  // The opt-out toggle needs BOTH calls, not either alone: the route (PUT
  // /api/me/leaderboard-opt-out) is what's actually authoritative - it
  // writes users.leaderboard_opt_out, the column server/db.js's
  // listLeaderboard filters on - while the reducer action only mirrors the
  // flag into meta.leaderboardOptOut for the toggle's own display. See
  // api.js's setLeaderboardOptOut doc comment for the server-side half.
  //
  // dispatchAction runs FIRST, synchronously (same optimistic-first order
  // every other action in this file uses) - the checkbox is a controlled
  // input bound to meta.leaderboardOptOut, and awaiting the network call
  // before flipping local state left a window where an unrelated re-render
  // (e.g. the 250ms production tick) would snap the checkbox back to
  // unchecked between the native click and the fetch resolving, a real
  // race caught during this task's own runtime verification (Playwright's
  // `.check()` failed with "did not change its state"). On a route failure,
  // the optimistic flip is reverted - the reducer action is purely for
  // display, so it must not keep claiming an opt-out that didn't actually
  // persist server-side.
  function toggleLeaderboardOptOut(next) {
    dispatchAction({ type: 'setLeaderboardOptOut', optOut: next });
    (async () => {
      const res = await setLeaderboardOptOut(next);
      if (res && !res.error) {
        // Bypass the reconcile-piggyback throttle here (see
        // handleReconcile) - this is a deliberate, low-frequency user
        // action, and the whole point of the toggle is seeing yourself
        // (dis)appear from the leaderboard without an up-to-8s wait for the
        // next unrelated reconcile to refresh it.
        lastEventFetchAtRef.current = Date.now();
        refreshEventData();
      } else {
        dispatchAction({ type: 'setLeaderboardOptOut', optOut: !next });
      }
    })();
  }

  function doMigrate() {
    const result = dispatchAction({ type: 'migrate' });
    if (result.ok) {
      setModal(null);
      setActiveTab('racks');
    }
  }
  function doSingularity() {
    const result = dispatchAction({ type: 'singularity' });
    if (result.ok) {
      setModal({ type: 'singularityDone', shards: result.shardsGained });
    }
  }
  function hardReset() {
    dispatchAction({ type: 'hardReset' });
    setModal(null);
    setProfileOpen(false);
  }
  function logout() {
    fetch('/auth/logout', { method: 'POST', credentials: 'include' }).finally(() => window.location.reload());
  }
  // Admin balancing editor (AdminBalancing.jsx, via ProfileView ->
  // ProfileSettings -> AdminPanel) hands back the freshly-saved/rolled-back
  // { version, data } after a successful write so the live game picks up
  // the new tunables immediately rather than waiting for a reload.
  // configRef is updated synchronously (same pattern as the boot effect)
  // since ticks/dispatches read it mid-render-cycle.
  // AdminBalancing hands us the BASELINE document it just saved (it reads and
  // writes GET/PUT /api/admin/config). What the game must actually run on is
  // the EFFECTIVE config - that baseline with any active event's modifiers
  // merged on top - so re-fetch rather than adopting the argument, or a save
  // made during a live event would silently drop the overlay client-side.
  function handleConfigSaved() {
    refreshConfig();
  }
  function claimGoal(g) {
    const result = dispatchAction({ type: 'claimGoal', id: g.id });
    if (result.ok) {
      setModal({ type: result.leveled ? 'levelUp' : 'goalClaim', level: result.level, goal: g });
    }
  }
  function claimRepeatable(def) {
    const level = stateRef.current.meta.repeatable[def.id] || 0;
    const result = dispatchAction({ type: 'claimRepeatable', id: def.id });
    if (result.ok) {
      const goal = { xp: def.xp(level), wafers: def.wafers(level) };
      setModal({ type: result.leveled ? 'levelUp' : 'goalClaim', level: result.level, goal });
    }
  }
  function claimAnomaly() {
    // Dispatch optimistically (as usual - this still moves credits/starts a
    // boost/clears the anomaly window locally so the toast disappears
    // immediately), but don't open the reward modal from this local result:
    // see openAnomalyRewardModal's doc comment. claimAnomaly is in api.js's
    // IMMEDIATE set, so the server round-trip (and thus the modal) follows
    // within one request, not up to the full 1s auto-flush window.
    const result = dispatchAction({ type: 'claimAnomaly' });
    if (result.ok) pendingAnomalyIdsRef.current.add(result._cid);
  }

  // ---------------------------------------------------------------------
  // Minigames - server-verified sessions (Task 11). Play starts a session
  // via startMinigame(game); the overlay then runs entirely locally (using
  // config-driven durations/spawn timings/pair counts) tracking its own
  // metric (taps/score/pairsFound); on natural end (timer hits 0, or Match
  // completing all pairs early) finishMinigameRound() posts that metric to
  // finishMinigame(sessionId, metric) and the server computes the clamped
  // payout. handleReconcile(res.state, []) folds the fresh canonical state
  // (which includes the updated server.gameCooldowns) back in and replays
  // anything still in flight - the same reconcile path optimistic economy
  // actions use. Cancel (the X button) just clears local minigame state and
  // never calls finish - the session simply expires server-side.
  //
  // setMinigameSynced wraps every mutation of the `minigame` state so
  // minigameRef.current is always updated in the same synchronous tick as
  // the state change (matching the configRef/stateRef pattern) rather than
  // lagging behind via a plain useEffect. That closes a race between Match's
  // early-completion path (tapMatchTile, below) and the 1s heartbeat's
  // natural-end check: both read minigameRef.current to decide whether to
  // call finishMinigameRound, and without a synchronous ref the heartbeat
  // could still see the pre-completion mg (lower pairsFound) and redeem the
  // session first, causing the legitimate full-match finish to lose the
  // race and get rejected by the server's 410. finishMinigameRound also
  // carries its own finishingRef guard as a second, structural layer against
  // ever posting two finish calls for the same session.
  // ---------------------------------------------------------------------

  function setMinigameSynced(updaterOrValue) {
    const next = typeof updaterOrValue === 'function' ? updaterOrValue(minigameRef.current) : updaterOrValue;
    minigameRef.current = next;
    setMinigame(next);
    return next;
  }

  // Applies a 429 cooldown_active response's retryAt directly onto local
  // canon (cloned, not mutated) so GamesPanel's countdown reflects it
  // immediately instead of waiting for the next unrelated reconcile.
  function applyGameCooldown(game, retryAt) {
    const prev = stateRef.current;
    const next = {
      ...prev,
      server: { ...prev.server, gameCooldowns: { ...prev.server.gameCooldowns, [game]: retryAt } },
    };
    stateRef.current = next;
    setState(next);
  }

  // Fallback for a 429 whose body didn't carry a retryAt (shouldn't happen
  // per the documented contract, but cheap to cover): re-fetch canonical
  // state outright and reconcile it in, which also refreshes gameCooldowns.
  async function refreshCooldownsFromServer() {
    const fresh = await fetchState();
    if (fresh && !fresh.error) {
      handleReconcile({ run: fresh.run, meta: fresh.meta, server: fresh.server }, []);
    }
  }

  async function handleMinigameStartFailure(game, res) {
    if (res && res.status === 429) {
      if (res.retryAt) applyGameCooldown(game, res.retryAt);
      else await refreshCooldownsFromServer();
    }
    showToast(REJECT_MESSAGES[res && res.error] || 'Action failed');
  }

  const MINIGAME_METRIC = {
    rush: (mg) => mg.taps,
    debug: (mg) => mg.score,
    match: (mg) => mg.pairsFound,
    balance: (mg) => mg.score,
  };

  async function finishMinigameRound(mg) {
    // Structural single-fire guard: if this exact session is already being
    // finished (e.g. Match's early-completion path and the heartbeat both
    // reached this point), the second caller no-ops instead of posting a
    // second /api/minigame/finish for the same sessionId.
    if (finishingRef.current === mg.sessionId) return;
    finishingRef.current = mg.sessionId;
    try {
      const metric = MINIGAME_METRIC[mg.type](mg);
      const res = await finishMinigame(mg.sessionId, metric);
      if (res && res.state) {
        handleReconcile(res.state, []);
        const { wafers } = res;
        let text;
        if (mg.type === 'rush') text = `${mg.taps} taps — +${wafers} wafers`;
        else if (mg.type === 'debug') text = `${mg.score} bugs squashed — +${wafers} wafers`;
        else if (mg.type === 'match') {
          const pairCount = configRef.current.minigames.match.pairCount;
          text = wafers > 0
            ? `${mg.pairsFound}/${pairCount} pairs matched — +${wafers} wafers`
            : `${mg.pairsFound}/${pairCount} pairs matched — no payout, not fully matched`;
        } else text = `${mg.score} stabilizations — +${wafers} wafers`;
        setModal({ type: 'minigameResult', text });
      } else {
        showToast(REJECT_MESSAGES[res && res.error] || 'Session expired');
      }
    } finally {
      finishingRef.current = null;
    }
  }

  async function startRushGame() {
    const res = await startMinigame('rush');
    if (res && res.sessionId) {
      setMinigameSynced({ type: 'rush', sessionId: res.sessionId, timeLeft: config.data.minigames.rush.durationSec, taps: 0 });
    } else {
      await handleMinigameStartFailure('rush', res);
    }
  }
  function tapRush() { setMinigameSynced((m) => (m && m.type === 'rush' ? { ...m, taps: m.taps + 1 } : m)); }

  function scheduleDebugSpawn(debugConf) {
    const delay = debugConf.spawnMinMs + Math.random() * (debugConf.spawnMaxMs - debugConf.spawnMinMs);
    debugSpawnRef.current = setTimeout(() => {
      setMinigameSynced((m) => {
        if (!m || m.type !== 'debug') return m;
        if (m.lit.length >= debugConf.maxLit) return m;
        let idx;
        do { idx = Math.floor(Math.random() * 9); } while (m.lit.includes(idx));
        return { ...m, lit: [...m.lit, idx] };
      });
      scheduleDebugSpawn(debugConf);
    }, delay);
  }
  async function startDebugGame() {
    const res = await startMinigame('debug');
    if (res && res.sessionId) {
      const debugConf = config.data.minigames.debug;
      setMinigameSynced({ type: 'debug', sessionId: res.sessionId, timeLeft: debugConf.durationSec, score: 0, lit: [] });
      if (debugSpawnRef.current) clearTimeout(debugSpawnRef.current);
      scheduleDebugSpawn(debugConf);
    } else {
      await handleMinigameStartFailure('debug', res);
    }
  }
  function tapDebugTile(idx) {
    setMinigameSynced((m) => {
      if (!m || m.type !== 'debug') return m;
      if (!m.lit.includes(idx)) return m;
      return { ...m, score: m.score + 1, lit: m.lit.filter((i) => i !== idx) };
    });
  }

  async function startMatchGame() {
    const res = await startMinigame('match');
    if (res && res.sessionId) {
      const pairCount = config.data.minigames.match.pairCount;
      const deck = [];
      for (let i = 0; i < pairCount; i++) deck.push(i, i);
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = deck[i]; deck[i] = deck[j]; deck[j] = tmp;
      }
      setMinigameSynced({ type: 'match', sessionId: res.sessionId, order: deck, revealed: Array(deck.length).fill(false), matched: Array(deck.length).fill(false), picks: [], timeLeft: config.data.minigames.match.durationSec, pairsFound: 0 });
    } else {
      await handleMinigameStartFailure('match', res);
    }
  }
  function tapMatchTile(idx) {
    setMinigameSynced((m) => {
      if (!m || m.type !== 'match') return m;
      if (m.matched[idx] || m.revealed[idx] || m.picks.length >= 2) return m;
      const revealed = [...m.revealed]; revealed[idx] = true;
      const picks = [...m.picks, idx];
      let next = { ...m, revealed, picks };
      if (picks.length === 2) {
        const [a, b] = picks;
        if (m.order[a] === m.order[b]) {
          const matched = [...m.matched]; matched[a] = true; matched[b] = true;
          const pairsFound = m.pairsFound + 1;
          const pairCount = configRef.current.minigames.match.pairCount;
          if (pairsFound === pairCount) {
            // Finish immediately - don't wait for the timer. minigameRef is
            // already null by the time this returns (setMinigameSynced
            // applies the `return null` below synchronously), so the 1s
            // heartbeat can't also see a completed-but-not-yet-null mg and
            // race this finish call.
            const finished = { ...next, matched, picks: [], pairsFound };
            setTimeout(() => finishMinigameRound(finished), 0);
            return null;
          }
          next = { ...next, matched, picks: [], pairsFound };
        } else {
          setTimeout(() => {
            setMinigameSynced((mm) => {
              if (!mm || mm.type !== 'match') return mm;
              const revealed2 = [...mm.revealed]; revealed2[a] = false; revealed2[b] = false;
              return { ...mm, revealed: revealed2, picks: [] };
            });
          }, 700);
        }
      }
      return next;
    });
  }

  async function startBalanceGame() {
    const res = await startMinigame('balance');
    if (res && res.sessionId) {
      setMinigameSynced({ type: 'balance', sessionId: res.sessionId, timeLeft: config.data.minigames.balance.durationSec, score: 0 });
    } else {
      await handleMinigameStartFailure('balance', res);
    }
  }
  function balanceScore(delta) {
    setMinigameSynced((m) => (m && m.type === 'balance' ? { ...m, score: Math.max(0, m.score + delta) } : m));
  }

  function cancelMinigame() {
    if (minigame && minigame.type === 'debug' && debugSpawnRef.current) { clearTimeout(debugSpawnRef.current); debugSpawnRef.current = null; }
    setMinigameSynced(null);
  }

  if (!loaded || !state || !config) {
    return (
      <div style={{ minHeight: '100vh', background: '#0E141B', color: textDim, display: 'flex', alignItems: 'center', justifyContent: 'center' }} className="font-mono text-sm">
        Booting rack...
      </div>
    );
  }

  const now = Date.now();
  const boostMultNow = state.server.boost && now < state.server.boost.until ? state.server.boost.mult : 1;
  const { eff, thresholds, racksMult, gridMult, overclockMult } = computeMults(state.meta, config.data, boostMultNow);
  const boost = state.server.boost;

  const heatCapacity = config.data.heat.capacity;
  const heatPct = Math.min(100, (state.run.heat / heatCapacity) * 100);
  const heatColor = heatPct < 50 ? teal : heatPct < 80 ? amber : danger;
  const heatOnCooldown = !!state.run.heatCooldownUntil && now < state.run.heatCooldownUntil;
  const cooldownSecondsLeft = heatOnCooldown ? Math.max(0, Math.ceil((state.run.heatCooldownUntil - now) / 1000)) : 0;
  const ventDisabled = now < (state.server.lastVentAt || 0) + config.data.heat.ventCooldownMs;
  // OverclockPanel expects run.heat as a 0-100 percent (its progress bar
  // width/label assume that scale) - heat's real scale is config-driven
  // (config.heat.capacity, e.g. 2000), so hand it a view of `run` with heat
  // pre-converted rather than changing the component's contract.
  const runForOverclock = { ...state.run, heat: heatPct };

  const ctx = goalCtx(state, config.data, now);
  const gain = migrateGain(state.run.lifetimeRun, eff.legacyGainMult);
  const singularityGain = Math.floor(Math.sqrt(state.meta.legacyCores || 0));

  const gridUnlocked = state.run.tiers[2].owned >= 1;
  const overclockUnlocked = state.run.tiers[3].owned >= 1;
  const singularityUnlocked = state.meta.legacyCores >= 50 || state.meta.stats.singularities > 0 || state.meta.singularityShards > 0;
  const coldStorageUnlocked = state.run.tiers[4].owned >= 1; // Server Room
  const anyReady = state.run.tiers.some((ts) => !ts.manager && ts.ready > 0.01);
  const anyManualOwned = state.run.tiers.some((ts) => ts.owned > 0 && !ts.manager);

  const xpNeeded = xpForLevel(state.meta.level);
  const anomalyActive = state.server.nextAnomalyAt <= now && now <= state.server.anomalyExpiresAt;
  const anomalyState = anomalyActive ? { label: anomalyLabel, expiresAt: state.server.anomalyExpiresAt } : null;

  // Live Events (v1.4): eventLive drives the banner + tab icon pulse;
  // eventTabVisible additionally covers the 48h post-end grace period
  // (isEventLive/isEventTabVisible are the module-scope helpers above the
  // component, shared with the activeTab-reset effect so this can't drift
  // from that check).
  const eventProgress = state.meta.eventProgress;
  const eventLive = isEventLive(eventProgress, now);
  const eventTabVisible = isEventTabVisible(eventProgress, pendingClaims, now);
  const eventGraceActive = !!eventProgress && !eventLive;
  // Unlike grid/overclock/singularity/coldstorage (always rendered, just
  // disabled until unlocked - see TabBar.jsx), the event tab is absent from
  // the bar entirely outside its window: "no event running" isn't a
  // progression state a player unlocks their way past.
  const visibleTabs = eventTabVisible ? TABS : TABS.filter((t) => t.id !== 'event');

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#0E141B',
        backgroundImage:
          'repeating-linear-gradient(0deg, rgba(255,255,255,0.03) 0px, rgba(255,255,255,0.03) 1px, transparent 1px, transparent 32px), repeating-linear-gradient(90deg, rgba(255,255,255,0.03) 0px, rgba(255,255,255,0.03) 1px, transparent 1px, transparent 32px)',
        color: '#EAEFF5',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      }}
      className="pb-24"
    >
      <style>{`
        @keyframes ledPulse { 0%,100% { opacity:1; } 50% { opacity:0.45; } }
        @keyframes floatIn { from { opacity:0; transform: translateY(8px);} to {opacity:1; transform:translateY(0);} }
        @keyframes popCollect { 0% {transform:scale(1);} 40% {transform:scale(1.06);} 100% {transform:scale(1);} }
        @keyframes eventPulse { 0%,100% {transform:scale(1);} 50% {transform:scale(1.15);} }
        .tier-card { animation: floatIn 0.35s ease both; }
        .led-on { animation: ledPulse 1.6s ease-in-out infinite; }
        .collect-pop { animation: popCollect 0.2s ease; }
        .event-icon { animation: eventPulse 0.9s ease-in-out infinite; }
      `}</style>

      <div className="sticky top-0 z-10 border-b" style={{ background: 'rgba(14,20,27,0.96)', backdropFilter: 'blur(6px)', borderColor: cardBorder }}>
        <div className="max-w-2xl mx-auto px-4 pt-3">
          <HeaderBar user={user} displayName={displayName} level={state.meta.level} onOpenProfile={() => setProfileOpen(true)} />
          <StatsRow run={state.run} meta={state.meta} totalOutputPerSec={ctx.totalOutputPerSec} xpNeeded={xpNeeded} boost={boost} boostMultNow={boostMultNow} />
          {eventLive && activeEvent && (
            <EventBanner event={activeEvent} endsAt={eventProgress.endsAt} onOpen={() => setActiveTab('event')} />
          )}
          <MigrateBar gain={gain} showCollectAll={anyManualOwned} collectDisabled={!anyReady} onMigrate={() => setModal({ type: 'migrate' })} onCollectAll={collectAll} />
          <TabBar tabs={visibleTabs} activeTab={activeTab} setActiveTab={setActiveTab} gridUnlocked={gridUnlocked} overclockUnlocked={overclockUnlocked} singularityUnlocked={singularityUnlocked} coldStorageUnlocked={coldStorageUnlocked} eventLive={eventLive} />
        </div>
      </div>

      {activeTab === 'racks' && (
        <RacksPanel run={state.run} unlockedUpTo={ctx.unlockedUpTo} racksMult={racksMult} thresholds={thresholds} eff={eff} onBuy={buy} onCollect={collectTier} onHire={hireManager} />
      )}

      {activeTab === 'grid' && (
        <GridPanel run={state.run} gridMult={gridMult} thresholds={thresholds} onBuy={buyGrid} />
      )}

      {activeTab === 'overclock' && (
        <OverclockPanel
          run={runForOverclock}
          overclockMult={overclockMult}
          thresholds={thresholds}
          onBuy={buyOverclock}
          onVent={ventHeat}
          ventDisabled={ventDisabled}
          heatColor={heatColor}
          onCooldown={heatOnCooldown}
          cooldownSecondsLeft={cooldownSecondsLeft}
        />
      )}

      {activeTab === 'upgrades' && <UpgradesPanel meta={state.meta} onBuy={buyUpgrade} />}

      {activeTab === 'singularity' && (
        <SingularityPanel meta={state.meta} singularityGain={singularityGain} onOpenSingularityConfirm={() => setModal({ type: 'singularity' })} onBuyShard={buyShardUpgrade} />
      )}

      {activeTab === 'goals' && (
        <GoalsPanel ctx={ctx} meta={state.meta} onClaimGoal={claimGoal} onClaimRepeatable={(def) => claimRepeatable(def)} />
      )}

      {activeTab === 'games' && !minigame && (
        <GamesPanel
          onStartRush={startRushGame}
          onStartDebug={startDebugGame}
          onStartMatch={startMatchGame}
          onStartBalance={startBalanceGame}
          cooldowns={state.server.gameCooldowns}
          minigamesConfig={config.data.minigames}
        />
      )}

      {activeTab === 'coldstorage' && (
        <ColdStoragePanel
          meta={state.meta}
          config={config.data}
          totalOutputPerSec={ctx.totalOutputPerSec}
          onClaimBlock={claimBlock}
          onClaimAllBlocks={claimAllBlocks}
          onResetTrack={resetTrack}
          onStartJob={startJob}
          onCancelJob={cancelJob}
          onClaimJob={claimJob}
          onBuyTapeUpgrade={buyTapeUpgrade}
        />
      )}

      {activeTab === 'event' && eventTabVisible && (
        <EventPanel
          event={activeEvent}
          eventProgress={eventProgress}
          meta={state.meta}
          leaderboard={eventLeaderboard}
          pendingClaims={pendingClaims}
          userId={user && user.id}
          optOut={state.meta.leaderboardOptOut}
          graceActive={eventGraceActive}
          onClaimRung={claimEventRung}
          onToggleOptOut={toggleLeaderboardOptOut}
        />
      )}

      {minigame && minigame.type === 'rush' && <RushOverlay minigame={minigame} onTap={tapRush} onCancel={cancelMinigame} />}
      {minigame && minigame.type === 'debug' && <DebugOverlay minigame={minigame} onTap={tapDebugTile} onCancel={cancelMinigame} />}
      {minigame && minigame.type === 'match' && <MatchOverlay minigame={minigame} pairCount={config.data.minigames.match.pairCount} onTap={tapMatchTile} onCancel={cancelMinigame} />}
      {minigame && minigame.type === 'balance' && <BalanceOverlay minigame={minigame} balanceConfig={config.data.minigames.balance} onScore={balanceScore} onCancel={cancelMinigame} />}

      <AnomalyToast anomalyState={anomalyState} windowMs={config.data.anomaly.windowMs} onClaim={claimAnomaly} />

      {rejectToast && (
        <div className="fixed left-4 right-4 top-4 z-20 max-w-sm mx-auto">
          <div className="w-full rounded-xl p-3 text-sm font-semibold text-center" style={{ background: inset, border: `1px solid ${danger}`, color: danger, boxShadow: '0 8px 24px rgba(0,0,0,0.45)' }}>
            {rejectToast.text}
          </div>
        </div>
      )}

      {profileOpen && (
        <ProfileView
          user={user}
          meta={state.meta}
          memberSince={user && user.memberSince}
          displayName={displayName}
          onUsernameChanged={setDisplayName}
          onClose={() => setProfileOpen(false)}
          onLogout={logout}
          onOpenReset={() => setModal({ type: 'reset' })}
          onConfigSaved={handleConfigSaved}
        />
      )}

      <ModalRoot
        modal={modal}
        setModal={setModal}
        meta={state.meta}
        gain={gain}
        singularityGain={singularityGain}
        onMigrate={doMigrate}
        onSingularity={doSingularity}
        onHardReset={hardReset}
      />
    </div>
  );
}

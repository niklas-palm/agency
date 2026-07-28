/**
 * Org switcher for the TopBar: shows the active org and a dropdown to switch
 * between the orgs you belong to, create a team org, and see/accept pending
 * invites. Sits next to the wordmark. Studio-quiet: a hairline chip that opens a
 * small card. All org state comes from OrgContext.
 */
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus, Check } from "lucide-react";
import type { Invite } from "@agency/shared";
import { useOrg } from "./OrgContext.js";
import { createOrg, listMyInvites, acceptInvite, declineInvite } from "./api.js";
import { TINT } from "./components.js";

export function OrgSwitcher() {
  const { orgs, activeOrgId, switchOrg, reload, nonce } = useOrg();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [invites, setInvites] = useState<Invite[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const active = orgs.find((o) => o.orgId === activeOrgId);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // Load pending invites on mount (so the count badge shows proactively - a user
  // has no reason to open the menu without a signal) and refresh them each time the
  // menu opens so the list is fresh. Re-runs on org changes via `nonce`.
  const loadInvites = () => listMyInvites().then(setInvites).catch(() => setInvites([]));

  // Proactively, so the count badge appears without opening the menu; re-runs when the
  // active org changes.
  useEffect(() => {
    void loadInvites();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  // And again each time the menu OPENS, so the list is fresh. Guarded on `open`
  // because the flag toggles both ways - without it, closing refetched too.
  useEffect(() => {
    if (!open) return;
    void loadInvites();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Each handler surfaces its own failure. Without a catch these were silent AND
  // confusing: the spinner cleared, the menu stayed open with the typed name intact,
  // and nothing said the create/accept/decline had failed (a rejected createOrg also
  // became an unhandled rejection).
  async function onCreate() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setErr("");
    try {
      const org = await createOrg(name.trim());
      setName("");
      setCreating(false);
      await switchOrg(org.orgId); // hop into the new org
      setOpen(false);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onAccept(orgId: string) {
    setBusy(true);
    setErr("");
    try {
      await acceptInvite(orgId);
      await reload();
      setInvites((inv) => inv.filter((i) => i.orgId !== orgId));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDecline(orgId: string) {
    setBusy(true);
    setErr("");
    try {
      await declineInvite(orgId);
      setInvites((inv) => inv.filter((i) => i.orgId !== orgId));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="focus-ring inline-flex max-w-[40vw] items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-sm text-ink transition-colors hover:bg-fill sm:max-w-[220px]"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="truncate font-medium">{active?.name ?? "…"}</span>
        {invites.length > 0 && (
          <span className="grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold text-white" style={{ backgroundColor: TINT.accent }}>
            {invites.length}
          </span>
        )}
        <ChevronDown className={`h-3.5 w-3.5 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute left-0 z-20 mt-1.5 w-72 rounded-xl border border-line bg-surface p-1.5 shadow-card fade" role="menu">
          {err && <p className="px-2 py-1.5 text-xs leading-relaxed" style={{ color: TINT.danger }}>{err}</p>}
          <div className="label px-2 py-1 text-faint">Organizations</div>
          {orgs.map((o) => (
            <button
              key={o.orgId}
              onClick={() => {
                void switchOrg(o.orgId);
                setOpen(false);
              }}
              className="focus-ring flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-fill"
              role="menuitem"
            >
              <span className="truncate">
                <span className="font-medium text-ink">{o.name}</span>
                <span className="ml-1.5 text-xs text-muted">{o.role}</span>
              </span>
              {o.orgId === activeOrgId && <Check className="h-4 w-4 shrink-0" style={{ color: TINT.live }} />}
            </button>
          ))}

          <div className="my-1 h-px bg-line" />

          {creating ? (
            <div className="flex items-center gap-1.5 p-1">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onCreate()}
                placeholder="Team name"
                className="field !min-h-0 !py-1.5 text-sm"
              />
              <button onClick={onCreate} disabled={busy || !name.trim()} className="btn !min-h-0 !px-3 !py-1.5 text-sm">
                Create
              </button>
            </div>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="focus-ring flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-ink hover:bg-fill"
              role="menuitem"
            >
              <Plus className="h-4 w-4 text-muted" />
              New organization
            </button>
          )}

          {invites.length > 0 && (
            <>
              <div className="my-1 h-px bg-line" />
              <div className="label px-2 py-1 text-faint">Pending invites</div>
              {invites.map((inv) => (
                <div key={inv.orgId} className="px-2 py-1.5">
                  <div className="truncate text-sm">
                    <span className="font-medium text-ink">{inv.orgName}</span>
                    <span className="ml-1.5 text-xs text-muted">as {inv.role}</span>
                  </div>
                  <div className="mt-1 flex gap-2">
                    <button onClick={() => onAccept(inv.orgId)} disabled={busy} className="btn !min-h-0 !px-2.5 !py-1 text-xs">
                      Accept
                    </button>
                    <button onClick={() => onDecline(inv.orgId)} disabled={busy} className="btn-ghost !min-h-0 !px-2.5 !py-1 text-xs">
                      Decline
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

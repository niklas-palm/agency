/**
 * Members page (admin only): the org's roster of members with role controls, an
 * invite-by-email form, and the list of pending invites. Mirrors the editorial
 * ledger style of the agent roster. Guarded by role at the nav + here: a
 * non-admin sees an access notice rather than the controls.
 */
import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import type { Member, Invite, Role } from "@agency/shared";
import { ALL_ROLES } from "@agency/shared";
import { useOrg, useCan } from "../OrgContext.js";
import { listMembers, updateMemberRole, removeMember, listOrgInvites, inviteMember, rescindInvite } from "../api.js";
import { ErrorNote, Skeleton } from "../components.js";

export function Members() {
  const { activeOrgId, me, nonce, reload, role } = useOrg();
  const { manageOrg } = useCan();
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    if (!activeOrgId) return;
    setLoading(true);
    try {
      const [m, inv] = await Promise.all([listMembers(activeOrgId), manageOrg ? listOrgInvites(activeOrgId) : Promise.resolve([])]);
      setMembers(m);
      setInvites(inv);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load members");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrgId, nonce]);

  // `role` is null until /me resolves, and a null role denies manageOrg - so checking
  // the denial first flashed "only an admin can…" at real admins on the first paint
  // (and made it permanent if /me failed). Wait for the role to be known.
  if (role === null) {
    return (
      <div>
        <Masthead />
        <Skeleton className="mt-6 h-32 rounded-xl" />
      </div>
    );
  }

  if (!manageOrg) {
    return (
      <div>
        <Masthead />
        <ErrorNote message="Only an organization admin can manage members." className="mt-6" />
      </div>
    );
  }

  return (
    <div>
      <Masthead />
      {err && <ErrorNote message={err} className="mt-6" />}

      <InviteForm
        orgId={activeOrgId!}
        onInvited={(inv) => setInvites((cur) => [...cur.filter((i) => i.email !== inv.email), inv])}
        onError={setErr}
      />

      {/* Members ledger */}
      <div className="mt-8">
        <div className="label mb-2">Members</div>
        {loading ? (
          <div className="skeleton h-24 rounded-xl" />
        ) : (
          <div className="divide-y divide-line border-y border-line">
            {members.map((m) => {
              const isSelf = m.userId === me?.userId;
              return (
                <MemberRow
                  key={m.userId}
                  member={m}
                  isSelf={isSelf}
                  orgId={activeOrgId!}
                  // A self-targeting change (leave / self-demote) alters the caller's
                  // OWN membership+role, so reload the whole org context (role, org
                  // list, nonce) - not just the members list, which would 403 once
                  // they've left. A change to someone else just re-lists.
                  onChanged={isSelf ? reload : load}
                  onError={setErr}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Pending invites */}
      {invites.length > 0 && (
        <div className="mt-8">
          <div className="label mb-2">Pending invites</div>
          <div className="divide-y divide-line border-y border-line">
            {invites.map((inv) => (
              <div key={inv.email} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-ink">{inv.email}</div>
                  <div className="text-xs text-muted">invited as {inv.role}</div>
                </div>
                <button
                  onClick={async () => {
                    try {
                      await rescindInvite(activeOrgId!, inv.email);
                      setInvites((cur) => cur.filter((i) => i.email !== inv.email));
                    } catch (e) {
                      setErr(e instanceof Error ? e.message : "Failed to rescind");
                    }
                  }}
                  className="btn-ghost !min-h-0 !px-2.5 !py-1.5 text-xs text-muted"
                >
                  Rescind
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Masthead() {
  return (
    <div>
      <p className="eyebrow">Your organization</p>
      <h1 className="mt-1 font-display text-[2rem] font-bold tracking-[-0.03em] text-ink">Members</h1>
    </div>
  );
}

function InviteForm({
  orgId,
  onInvited,
  onError,
}: {
  orgId: string;
  onInvited: (inv: Invite) => void;
  onError: (e: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!email.trim() || busy) return;
    setBusy(true);
    try {
      const inv = await inviteMember(orgId, email.trim(), role);
      setEmail("");
      onInvited(inv);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to invite");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card mt-6 p-4">
      <div className="label mb-2">Invite someone</div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="name@company.com"
          className="field flex-1"
        />
        <RolePicker value={role} onChange={setRole} />
        <button onClick={submit} disabled={busy || !email.trim()} className="btn !px-5">
          Send invite
        </button>
      </div>
      <p className="mt-2 text-xs text-muted">
        They'll see a pending invite next time they sign in. An invite is tied to the email address.
      </p>
    </div>
  );
}

function MemberRow({
  member,
  isSelf,
  orgId,
  onChanged,
  onError,
}: {
  member: Member;
  isSelf: boolean;
  orgId: string;
  onChanged: () => void;
  onError: (e: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function changeRole(role: Role) {
    setBusy(true);
    try {
      await updateMemberRole(orgId, member.userId, role);
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to change role");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await removeMember(orgId, member.userId);
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to remove");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-ink">
          {member.email ?? member.userId}
          {isSelf && <span className="ml-1.5 text-xs text-muted">(you)</span>}
        </div>
        <div className="font-mono text-xs text-faint">joined {member.joinedAt.slice(0, 10)}</div>
      </div>
      <div className="flex items-center gap-2">
        {/* You can't change your OWN role or remove yourself here - that's how an
            admin console could accidentally orphan an org (or self-demote). Leaving
            an org is a separate, explicit action below. Managing OTHERS is unchanged. */}
        <RolePicker value={member.role} onChange={changeRole} disabled={busy || isSelf} />
        {isSelf ? (
          <button
            onClick={remove}
            disabled={busy}
            className="btn-ghost !min-h-0 !px-2.5 !py-1.5 text-xs text-muted"
            title="Leave this organization"
          >
            Leave
          </button>
        ) : (
          <button
            onClick={remove}
            disabled={busy}
            className="focus-ring rounded-md p-1.5 text-muted transition-colors hover:text-danger"
            title="Remove member"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function RolePicker({ value, onChange, disabled }: { value: Role; onChange: (r: Role) => void; disabled?: boolean }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as Role)}
      disabled={disabled}
      className="field !min-h-0 !w-auto !py-1.5 text-sm"
    >
      {ALL_ROLES.map((r) => (
        <option key={r} value={r}>
          {r}
        </option>
      ))}
    </select>
  );
}

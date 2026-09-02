/**
 * Config editors shared by the create + configure agent forms:
 *  - SkillPicker: checklist of the user's skills to attach (by id).
 *  - IntegrationPicker: checklist of the user's integrations to attach (by id).
 *  - EnvEditor: key/value rows for per-agent environment variables.
 * All are controlled (value + onChange), so the parent owns the config state and
 * its dirty/version logic.
 */
import { useEffect, useState } from "react";
import type { Skill, Integration, Member } from "@agency/shared";
import { Plus, X } from "lucide-react";
import { listSkills, listIntegrations, listMembers } from "./api.js";
import { useOrg } from "./OrgContext.js";

/** Attach/detach the user's skills to an agent. `value` is the attached id list. */
export function SkillPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const [skills, setSkills] = useState<Skill[] | null>(null);

  useEffect(() => {
    listSkills().then(setSkills).catch(() => setSkills([]));
  }, []);

  function toggle(id: string, on: boolean) {
    onChange(on ? [...value, id] : value.filter((x) => x !== id));
  }

  if (!skills) return <p className="text-xs text-muted">Loading skills…</p>;
  if (skills.length === 0) {
    return (
      <p className="text-xs text-muted">
        No skills yet.{" "}
        <a href="#/skills" className="text-accent-ink hover:underline">
          Create one
        </a>{" "}
        to attach it here.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {skills.map((s) => {
        const on = value.includes(s.id);
        return (
          <label
            key={s.id}
            className="flex cursor-pointer items-start gap-3 rounded-lg border border-line px-3 py-2.5 transition-colors hover:bg-raised"
          >
            <input
              type="checkbox"
              checked={on}
              onChange={(e) => toggle(s.id, e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
            />
            <span className="min-w-0">
              <span className="block truncate font-mono text-xs font-medium text-ink">{s.name}</span>
              <span className="block truncate text-xs text-muted">{s.description}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/**
 * Attach/detach the user's integrations to an agent. `value` is the attached id list.
 * `onLoaded` (optional) hands the fetched list back to the parent so it can map the
 * attached ids → names for the system-prompt preview (the preview needs names, and this
 * component is the one place that fetches them - so we surface them rather than fetch twice).
 */
export function IntegrationPicker({
  value,
  onChange,
  onLoaded,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  onLoaded?: (list: Integration[]) => void;
}) {
  const [integrations, setIntegrations] = useState<Integration[] | null>(null);

  useEffect(() => {
    listIntegrations()
      .then((list) => {
        setIntegrations(list);
        onLoaded?.(list);
      })
      .catch(() => setIntegrations([]));
    // Fetch once on mount; onLoaded is a stable setter from the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle(id: string, on: boolean) {
    onChange(on ? [...value, id] : value.filter((x) => x !== id));
  }

  if (!integrations) return <p className="text-xs text-muted">Loading integrations…</p>;
  if (integrations.length === 0) {
    return (
      <p className="text-xs text-muted">
        No integrations yet.{" "}
        <a href="#/integrations" className="text-accent-ink hover:underline">
          Create one
        </a>{" "}
        to attach it here.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {integrations.map((i) => {
        const on = value.includes(i.id);
        return (
          <label
            key={i.id}
            className="flex cursor-pointer items-start gap-3 rounded-lg border border-line px-3 py-2.5 transition-colors hover:bg-raised"
          >
            <input
              type="checkbox"
              checked={on}
              onChange={(e) => toggle(i.id, e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
            />
            <span className="min-w-0">
              <span className="block truncate font-mono text-xs font-medium text-ink">{i.name}</span>
              <span className="block truncate text-xs text-muted">{i.description}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** Edit an agent's environment variables as key/value rows. */
export function EnvEditor({
  value,
  onChange,
}: {
  value: Record<string, string>;
  onChange: (env: Record<string, string>) => void;
}) {
  // The row list is our OWN state (seeded once from `value`), so an empty or
  // in-progress key persists as you type instead of collapsing away. Every edit
  // reports the record (dropping empty/duplicate keys) up to the parent, but the
  // editable rows stay exactly as typed.
  const [rows, setRows] = useState<[string, string][]>(() => Object.entries(value));

  function apply(next: [string, string][]) {
    setRows(next);
    const env: Record<string, string> = {};
    for (const [k, v] of next) if (k.trim()) env[k.trim()] = v; // last wins on dup
    onChange(env);
  }

  function update(i: number, key: string, val: string) {
    apply(rows.map((r, j) => (j === i ? ([key, val] as [string, string]) : r)));
  }
  function add() {
    apply([...rows, ["", ""]]);
  }
  function remove(i: number) {
    apply(rows.filter((_, j) => j !== i));
  }

  return (
    <div className="space-y-2">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            className="field font-mono !py-2"
            value={k}
            onChange={(e) => update(i, e.target.value, v)}
            placeholder="API_KEY"
            aria-label="Variable name"
          />
          <input
            className="field font-mono !py-2"
            value={v}
            onChange={(e) => update(i, k, e.target.value)}
            placeholder="value"
            aria-label="Variable value"
          />
          <button
            type="button"
            onClick={() => remove(i)}
            className="focus-ring shrink-0 rounded-md p-2 text-muted transition-colors hover:text-danger-ink"
            title="Remove"
            aria-label="Remove variable"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
      <button type="button" onClick={add} className="btn-ghost !min-h-0 !px-2.5 !py-1.5 text-xs">
        <Plus className="h-3.5 w-3.5" />
        Add variable
      </button>
      {rows.length > 0 && (
        <p className="text-xs text-muted">
          Available to the agent's tools (e.g. <span className="font-mono">$API_KEY</span> in bash). Values are
          stored as-is.
        </p>
      )}
    </div>
  );
}

/**
 * Pick which org members may MANAGE (edit/delete) a resource, beyond its creator
 * + org admins (who always can). `value` is the granted userId list. Only the
 * creator + admins can be here, so it's shown only when the caller can manage the
 * resource. Members are listed by email (falling back to userId); the creator +
 * admins are excluded from the choices since their access is implicit.
 *
 * Personal orgs have a single member, so there's nobody to grant to - the picker
 * renders a short note instead of an empty box.
 */
export function ManagerPicker({
  value,
  onChange,
  createdBy,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  /** The resource's creator (implicit manager) - omitted from the choices. On
   *  create this is the caller; on edit it's the stored creator. */
  createdBy?: string;
}) {
  const { activeOrgId } = useOrg();
  const [members, setMembers] = useState<Member[] | null>(null);

  useEffect(() => {
    if (!activeOrgId) return;
    listMembers(activeOrgId).then(setMembers).catch(() => setMembers([]));
  }, [activeOrgId]);

  function toggle(id: string, on: boolean) {
    onChange(on ? [...value, id] : value.filter((x) => x !== id));
  }

  if (!members) return <p className="text-xs text-muted">Loading members…</p>;
  // Candidates: everyone who isn't the creator and isn't an admin (admins already
  // manage everything). A viewer can be listed, but the grant only takes EFFECT
  // once they're an editor - a viewer's scope set is read-only, so requireScope
  // ("write") 403s their edit until promoted. The grant is recorded, then activates
  // on promotion.
  const candidates = members.filter((m) => m.userId !== createdBy && m.role !== "admin");
  if (candidates.length === 0) {
    return (
      <p className="text-xs text-muted">
        No one else to grant. The creator and org admins can always manage this; invite editors or viewers to
        share management.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {candidates.map((m) => {
        const on = value.includes(m.userId);
        return (
          <label
            key={m.userId}
            className="flex cursor-pointer items-center gap-3 rounded-lg border border-line px-3 py-2 transition-colors hover:bg-raised"
          >
            <input
              type="checkbox"
              checked={on}
              onChange={(e) => toggle(m.userId, e.target.checked)}
              className="h-4 w-4 shrink-0 accent-accent"
            />
            <span className="min-w-0 flex-1 truncate text-sm text-ink">{m.email ?? m.userId}</span>
            <span className="shrink-0 font-mono text-xs text-faint">{m.role}</span>
          </label>
        );
      })}
    </div>
  );
}

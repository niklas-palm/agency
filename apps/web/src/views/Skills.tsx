/**
 * Skills management: create, edit, and delete reusable skills. A skill is a named
 * Markdown document you attach to agents (on create/configure); attaching stores
 * only the id, so editing a skill here updates every agent that uses it on its
 * next session. Each row shows how many agents currently use it.
 */
import { useEffect, useState } from "react";
import type { Skill } from "@agency/shared";
import { parseSkillDoc, SKILL_TEMPLATE } from "@agency/shared";
import { Plus, Trash2, Pencil, Boxes, Eye } from "lucide-react";
import { listSkills, createSkill, updateSkill, deleteSkill } from "../api.js";
import { useCan, useOrg } from "../OrgContext.js";
import { ManagerPicker } from "../AgentExtras.js";
import { ErrorNote, Skeleton, SharedBadge, ToggleRow, TINT } from "../components.js";

export function Skills() {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [err, setErr] = useState("");
  // The skill being edited, `"new"` for the create form, or null (list only).
  const [editing, setEditing] = useState<Skill | "new" | null>(null);
  const { write, canManage } = useCan();
  const { nonce } = useOrg();

  // Bare reload, for after a mutation in the CURRENT org.
  const load = () => listSkills().then((r) => { setSkills(r); setErr(""); }).catch((e) => setErr(String(e)));
  useEffect(() => {
    // Guarded, because this also runs on an ORG SWITCH: clear first so the previous
    // org's rows can't read as the new org's while the fetch is in flight, and ignore
    // a late reply - the in-flight request carries the OLD org header, so resolving
    // after the new one would render another org's data here.
    let stop = false;
    setSkills(null);
    setErr("");
    listSkills()
      .then((r) => !stop && setSkills(r))
      .catch((e) => !stop && setErr(String(e)));
    return () => {
      stop = true;
    };
  }, [nonce]);

  return (
    <div className="space-y-6 rise">
      <header className="flex items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Reusable know-how</p>
          <h1 className="mt-1.5 font-display text-[2.5rem] font-bold leading-[1.05] tracking-[-0.03em] text-ink">Skills</h1>
          <p className="mt-2.5 max-w-xl text-sm leading-relaxed text-muted">
            Reusable instructions you attach to agents. Edit a skill once and every agent using it
            picks up the change on its next run.
          </p>
        </div>
        {editing === null && write && (
          <button className="btn shrink-0" onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" />
            New skill
          </button>
        )}
      </header>

      {err && <ErrorNote message={err} />}

      {editing !== null && (
        <SkillEditor
          skill={editing === "new" ? null : editing}
          // Read-only when opened for a skill the caller can't manage (a
          // co-member's shared one) - they can view its contents, not save.
          readOnly={editing !== "new" && !canManage(editing)}
          onDone={() => {
            setEditing(null);
            void load();
          }}
          onCancel={() => setEditing(null)}
          onError={setErr}
        />
      )}

      {editing === null && (
        <>
          {!skills && !err && <Skeleton className="h-32 rounded-xl" />}
          {skills && skills.length === 0 && (
            <EmptyState canCreate={write} onCreate={() => setEditing("new")} />
          )}
          {skills && skills.length > 0 && (
            <div className="card divide-y divide-line overflow-hidden">
              {skills.map((s) => (
                <SkillRow
                  key={s.id}
                  skill={s}
                  // Editable only by a writer who owns it (or an org admin); a co-member's
                  // shared skill is read-only here.
                  canManage={canManage(s)}
                  onEdit={() => setEditing(s)}
                  onChanged={load}
                  onError={setErr}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SkillRow({
  skill,
  canManage,
  onEdit,
  onChanged,
  onError,
}: {
  skill: Skill;
  canManage: boolean;
  onEdit: () => void;
  onChanged: () => void;
  onError: (e: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const used = skill.usedByAgentCount ?? 0;

  async function remove() {
    setBusy(true);
    onError("");
    try {
      await deleteSkill(skill.id);
      onChanged();
    } catch (e) {
      onError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-4 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-sm font-medium text-ink">{skill.name}</span>
          <span className="chip shrink-0 !px-1.5 !py-0">{used} {used === 1 ? "agent" : "agents"}</span>
          <SharedBadge shared={skill.shared} />
        </div>
        <div className="mt-0.5 truncate text-xs text-muted">{skill.description}</div>
      </div>
      {/* A skill the caller can't manage (a co-member's shared one) is still
          openable read-only via a View button; managers get edit/delete. */}
      {!canManage ? (
        <button className="btn-ghost !min-h-0 !px-2.5 !py-2 text-muted" onClick={onEdit} title="View skill">
          <Eye className="h-4 w-4" />
        </button>
      ) : confirming ? (
        <div className="flex shrink-0 items-center gap-2">
          {used > 0 && <span className="hidden text-xs text-muted sm:inline">Used by {used}. Delete anyway?</span>}
          <button
            className="btn-ghost !min-h-0 !px-2.5 !py-2 border-danger/40 text-danger-ink hover:bg-danger/5"
            onClick={remove}
            disabled={busy}
          >
            {busy ? "Deleting…" : "Delete"}
          </button>
          <button className="btn-ghost !min-h-0 !px-2.5 !py-2" onClick={() => setConfirming(false)} disabled={busy}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-1">
          <button className="btn-ghost !min-h-0 !px-2.5 !py-2 text-muted" onClick={onEdit} title="Edit skill">
            <Pencil className="h-4 w-4" />
          </button>
          <button
            className="btn-ghost !min-h-0 !px-2.5 !py-2 text-muted hover:text-danger-ink"
            onClick={() => setConfirming(true)}
            title="Delete skill"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

function SkillEditor({
  skill,
  readOnly = false,
  onDone,
  onCancel,
  onError,
}: {
  skill: Skill | null;
  readOnly?: boolean;
  onDone: () => void;
  onCancel: () => void;
  onError: (e: string) => void;
}) {
  // A skill is authored as ONE SKILL.md document. The name + description live in
  // its frontmatter and are parsed out live (the doc is the source of truth), so
  // there are no separate form fields.
  const { canEditManagers } = useCan();
  const [content, setContent] = useState(skill?.content ?? SKILL_TEMPLATE);
  // New skills default to shared with the org; editing keeps the stored flag.
  const [shared, setShared] = useState(skill?.shared ?? true);
  // Extra org members who may manage this skill (beyond creator + admins).
  const [managers, setManagers] = useState<string[]>(skill?.managers ?? []);
  const [busy, setBusy] = useState(false);
  // Only the creator/admin may edit the managers list (a granted manager can edit
  // content but not re-delegate) - mirrors the server's patchManagers gate.
  const showManagers = !readOnly && shared && canEditManagers({ createdBy: skill?.createdBy });

  const parsed = parseSkillDoc(content);
  const untouched = content.trim() === SKILL_TEMPLATE.trim();
  const canSave = parsed.errors.length === 0 && !untouched && !busy;

  async function save() {
    setBusy(true);
    onError("");
    try {
      if (skill) await updateSkill(skill.id, { content, shared, managers });
      else await createSkill({ content, shared, managers });
      onDone();
    } catch (e) {
      onError(String(e));
      setBusy(false);
    }
  }

  return (
    <section className="card p-5 sm:p-6">
      <header className="mb-5">
        <h2 className="text-base font-semibold tracking-tight text-ink">
          {readOnly ? "View skill" : skill ? "Edit skill" : "New skill"}
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          {readOnly
            ? "A skill shared with your organization. You can read it here; only its creator or an org admin can edit it."
            : "Write the skill as a single SKILL.md document: YAML frontmatter with name and description, then a titled body with sections. The name + description are read from the frontmatter; the model loads the full instructions on demand when relevant."}
        </p>
      </header>
      <div className="space-y-4">
        <textarea
          className="field min-h-[420px] resize-y font-mono text-xs leading-relaxed"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
          readOnly={readOnly}
        />

        {/* Live parse: show what we read + what's missing from the standard shape. */}
        {parsed.errors.length > 0 ? (
          <div
            className="rounded-lg border px-3.5 py-2.5 text-xs"
            style={{ borderColor: `${TINT.warn}33`, backgroundColor: `${TINT.warn}0d`, color: "#8a5a0a" }}
          >
            <div className="mb-1 font-medium">To match the SKILL.md standard, fix:</div>
            <ul className="list-inside list-disc space-y-0.5">
              {parsed.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted">
            <span className="text-pine-deep">✓ valid</span>
            <span>
              name <span className="text-ink">{parsed.name}</span>
            </span>
            <span className="truncate">
              description <span className="text-ink">{parsed.description}</span>
            </span>
          </div>
        )}

        <ToggleRow
          checked={shared}
          onChange={setShared}
          title="Shared with organization"
          desc="When on, every member of this organization can attach this skill to their agents. When off, only you can."
          disabled={readOnly}
        />

        {/* Managers: extra members who may edit/delete this skill (creator + admins
            always can). Shown only to the creator/admin (who may change the grant). */}
        {showManagers && (
          <div>
            <div className="label mb-2">Managers</div>
            <p className="mb-2 text-xs text-muted">
              Members who can edit or delete this skill, in addition to you and org admins.
            </p>
            <ManagerPicker value={managers} onChange={setManagers} createdBy={skill?.createdBy} />
          </div>
        )}

        <div className="flex items-center gap-3">
          {readOnly ? (
            <button className="btn-ghost" onClick={onCancel}>
              Close
            </button>
          ) : (
            <>
              <button className="btn" disabled={!canSave} onClick={save}>
                {busy ? "Saving…" : skill ? "Save changes" : "Create skill"}
              </button>
              <button className="btn-ghost" onClick={onCancel} disabled={busy}>
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function EmptyState({ canCreate, onCreate }: { canCreate: boolean; onCreate: () => void }) {
  return (
    <div className="card flex flex-col items-center gap-4 px-6 py-16 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-fill text-amber-deep">
        <Boxes className="h-5 w-5" />
      </span>
      <p className="max-w-xs text-sm leading-relaxed text-muted">
        {canCreate
          ? "No skills yet. Create one to give your agents reusable, on-demand instructions."
          : "No skills are shared with you in this organization yet."}
      </p>
      {canCreate && (
        <button className="btn mt-1" onClick={onCreate}>
          <Plus className="h-4 w-4" />
          New skill
        </button>
      )}
    </div>
  );
}


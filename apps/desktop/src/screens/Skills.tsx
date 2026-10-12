/**
 * Skills manager (P5).
 *
 * Laid out the way the host app lays its skills screen out, because the operator already knows that
 * shape and it is a better one than the stacked cards it replaces: a title with the search beside
 * it, a band per group with the group's name and count on the left and its controls on the right,
 * one panel of rows — each with a switch and a delete on it — and a footer saying how many are in
 * play. A row is a row in a panel rather than a card, so a list of thirty still reads as a list.
 *
 * Two things on this screen are ours and stay ours. The catalog, because builtins are shipped with
 * the app rather than scanned from a folder: an uninstalled one has to be visible somewhere, and
 * "Available" is that somewhere. And the paste composer, because installing a skill here means
 * handing over a SKILL.md, not pointing at a directory.
 *
 * The one thing this screen has to be honest about is what a skill is: instructions, not
 * capability. A skill cannot widen the tool surface — the sandbox still allows exactly the four
 * tools in tools.rs. What installing one does is put its instructions into the agent's context,
 * where they will steer how those four tools get used.
 *
 * So the body is shown before install and after it, and the line below the title says what
 * installing one actually means. Both are kept to a line, because a warning that pushes the list
 * off the screen is a warning the operator learns to scroll past.
 */
import { useEffect, useMemo, useState } from "react";
import { Button, EmptyState, Field, Modal, inputCls, inputStyle } from "../components/atoms";
import { useUi } from "../ui-state";
import {
  installSkill,
  listSkills,
  parseSkill,
  recordContext,
  setSkillEnabled,
  skillsCatalog,
  slugifySkill,
  uninstallSkill,
  type Skill,
} from "../store";

/** One line, because the screen's job is the list: what a skill is, and what it may not do. */
const TRUST_NOTE =
  "Manage installed and builtin skills. An enabled skill is offered to the agent, which loads its " +
  "instructions on demand. A skill is a procedure, not a permission: it cannot widen the tools the " +
  "agent already has, only steer how they are used.";

type Status = "all" | "enabled" | "disabled";
type Source = "all" | "builtin" | "user";

export function SkillsScreen() {
  const tick = useUi((s) => s.tick);
  const bump = useUi((s) => s.bump);
  const [installed, setInstalled] = useState<Skill[]>([]);
  const [catalog, setCatalog] = useState<Skill[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>("all");
  const [source, setSource] = useState<Source>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Skill | null>(null);
  const [authoring, setAuthoring] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [draft, setDraft] = useState("");
  const [parsed, setParsed] = useState<{ name: string; description: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listSkills(), skillsCatalog()])
      .then(([s, c]) => {
        setInstalled(s);
        setCatalog(c);
        setRefreshing(false);
      })
      .catch(() => setRefreshing(false));
  }, [tick]);

  const installedSlugs = useMemo(() => new Set(installed.map((s) => s.slug)), [installed]);
  const available = useMemo(() => catalog.filter((c) => !installedSlugs.has(c.slug)), [catalog, installedSlugs]);

  /**
   * One filter for both lists. It reads name, slug and description, because the description is
   * usually what you remember about a skill you are looking for — the name is the thing you have
   * forgotten.
   */
  const matches = (s: Skill): boolean => {
    if (source !== "all" && s.source !== source) return false;
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return (
      s.name.toLowerCase().includes(needle) ||
      s.slug.includes(needle) ||
      s.description.toLowerCase().includes(needle)
    );
  };

  // A status filter says nothing about a skill that is not installed — it is neither enabled nor
  // disabled — so the Available group drops out under one rather than mislabelling its rows.
  const shownInstalled = installed.filter((s) => matches(s) && (status === "all" || s.enabled === (status === "enabled")));
  const shownAvailable = status === "all" ? available.filter(matches) : [];
  const enabledCount = installed.filter((s) => s.enabled).length;

  async function doInstall(skill: { slug: string; name: string; description: string; body: string }) {
    setError(null);
    try {
      await installSkill(skill);
      // Installing a skill is a context event in its own right: the graph should be able to
      // answer "which skills were in play" without reading the skills table back.
      await recordContext(
        [{ id: `skill:${skill.slug}`, kind: "skill", label: skill.name, source: "ui", session_id: null, ts: Date.now(), meta_json: JSON.stringify({ slug: skill.slug, event: "installed" }) }],
        [],
      ).catch(() => undefined);
      bump();
    } catch (e) {
      setError(String(e));
    }
  }

  async function doDelete(slug: string) {
    setError(null);
    setConfirming(null);
    try {
      await uninstallSkill(slug);
      bump();
    } catch (e) {
      setError(String(e));
    }
  }

  async function doToggle(slug: string, enabled: boolean) {
    setError(null);
    try {
      await setSkillEnabled(slug, enabled);
      bump();
    } catch (e) {
      setError(String(e));
    }
  }

  async function doParseDraft() {
    setError(null);
    if (!draft.trim()) {
      setParsed(null);
      return;
    }
    const p = await parseSkill(draft);
    setParsed(p);
  }

  async function doInstallDraft() {
    setError(null);
    if (!draft.trim()) return;
    const p = parsed ?? (await parseSkill(draft));
    const name = p.name.trim() || "Untitled skill";
    const slug = await slugifySkill(name);
    await doInstall({ slug, name, description: p.description.trim() || "no description", body: p.body.trim() });
    setDraft("");
    setParsed(null);
    setAuthoring(false);
  }

  return (
    <div className="mx-auto max-w-4xl">
      {/* The filters sit with the search rather than in the band below: they are all questions
          asked of the whole screen, and the band belongs to its group. */}
      <div className="flex items-center gap-2">
        <h1 className="text-[20px] font-semibold">Skills</h1>
        <div className="ml-auto flex items-center gap-2">
          <Filter
            label="Status filter"
            value={status}
            onChange={(v) => setStatus(v as Status)}
            options={[["all", "All"], ["enabled", "Enabled"], ["disabled", "Disabled"]]}
          />
          <Filter
            label="Source filter"
            value={source}
            onChange={(v) => setSource(v as Source)}
            options={[["all", "All"], ["builtin", "Builtin"], ["user", "Yours"]]}
          />
          <div className="relative w-[230px]">
            <SearchGlyph />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search skills..."
              aria-label="Search skills"
              className={`${inputCls} pl-7`}
              style={inputStyle}
            />
          </div>
        </div>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed" style={{ color: "var(--text-dim)" }}>
        {TRUST_NOTE}
      </p>

      {error && (
        <p className="mt-3 text-[12px]" style={{ color: "var(--danger)" }}>{error}</p>
      )}

      <Band
        title="Installed"
        count={shownInstalled.length}
        right={
          <>
            {refreshing && <span className="text-[11px]" style={{ color: "var(--text-dim)" }}>Refreshing...</span>}
            {/* Icon-only, the way the reference does it: a re-read of the same table needs no
                label, and a worded ghost button beside a filled one reads as a text link. */}
            <Button
              variant="ghost"
              ariaLabel="Refresh skills"
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true);
                bump();
              }}
            >
              <span title="Refresh" className="flex items-center px-0.5">
                <RefreshGlyph />
              </span>
            </Button>
            <Button variant="primary" ariaLabel="New skill" onClick={() => setAuthoring(true)}>+ New</Button>
          </>
        }
      />
      {shownInstalled.length === 0 ? (
        <EmptyState
          title={
            installed.length === 0
              ? "Nothing installed yet — install a builtin below, or write your own with + New."
              : "No skills found"
          }
        />
      ) : (
        <Panel testId="skills-installed">
          {shownInstalled.map((s) => (
            <Row key={s.slug} slug={s.slug} body={open === s.slug ? <Body body={s.body} /> : null}>
              <Identity skill={s} expanded={open === s.slug} onToggleBody={() => setOpen(open === s.slug ? null : s.slug)} />
              <Switch skill={s} onToggle={(next) => void doToggle(s.slug, next)} />
              <DeleteButton skill={s} onAsk={() => setConfirming(s)} />
            </Row>
          ))}
        </Panel>
      )}
      {/* The footer is a statement about the whole installed set, so no filter moves it. */}
      <p className="mt-2 text-[11px]" style={{ color: "var(--text-faint)" }}>
        {installed.length} skills · {enabledCount} enabled
      </p>

      {status === "all" && (
        <>
          <Band title="Available" count={shownAvailable.length} />
          {shownAvailable.length === 0 ? (
            <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>
              {available.length === 0 ? "Every builtin skill is installed." : "No skills found"}
            </p>
          ) : (
            <Panel testId="skills-available">
              {shownAvailable.map((s) => (
                <Row
                  key={s.slug}
                  slug={`cat:${s.slug}`}
                  body={open === `cat:${s.slug}` ? <Body body={s.body} /> : null}
                >
                  <Identity
                    skill={s}
                    expanded={open === `cat:${s.slug}`}
                    onToggleBody={() => setOpen(open === `cat:${s.slug}` ? null : `cat:${s.slug}`)}
                  />
                  <Button
                    variant="primary"
                    ariaLabel={`Install ${s.name}`}
                    onClick={() => void doInstall({ slug: s.slug, name: s.name, description: s.description, body: s.body })}
                  >
                    install
                  </Button>
                </Row>
              ))}
            </Panel>
          )}
        </>
      )}

      {confirming && (
        <Modal title="Delete skill" onClose={() => setConfirming(null)}>
          <p className="mb-3 text-[12px] leading-relaxed" style={{ color: "var(--text-dim)" }}>
            Delete <b>{confirming.name}</b>?{" "}
            {confirming.source === "user"
              ? "This skill was added by you, so it is gone for good — the text would have to be pasted in again."
              : "The builtin stays in the catalog and can be installed again."}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirming(null)}>Cancel</Button>
            <Button variant="danger" ariaLabel="Confirm delete" onClick={() => void doDelete(confirming.slug)}>
              Delete
            </Button>
          </div>
        </Modal>
      )}

      {authoring && (
        <Modal title="New skill" onClose={() => setAuthoring(false)} width={600}>
          <Field label="Paste a SKILL.md">
            <textarea
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setParsed(null);
              }}
              onBlur={doParseDraft}
              rows={10}
              placeholder={"---\nname: My Skill\ndescription: what it is for\n---\n1. Read the file.\n2. Do the thing.\n3. Report what you found."}
              className={`${inputCls} mono`}
              style={{ ...inputStyle, resize: "vertical" }}
            />
          </Field>
          <p className="mb-2 text-[11px]" style={{ color: "var(--text-faint)" }}>
            Optional frontmatter (<code className="mono">name:</code> and <code className="mono">description:</code>)
            above a <code className="mono">---</code> line, then the instructions. A name without a
            description is fine; a skill without instructions is not.
          </p>
          {parsed && (
            <div className="mb-2 rounded border p-2 text-[11px]" style={{ borderColor: "var(--border)", background: "var(--bg)" }}>
              <div><b>{parsed.name || "(name inferred from the slug)"}</b> — {parsed.description || "(no description)"}</div>
              <div className="mt-1" style={{ color: "var(--text-faint)" }}>{parsed.body.length} characters of instructions</div>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAuthoring(false)}>Cancel</Button>
            <Button variant="primary" disabled={!draft.trim()} onClick={() => void doInstallDraft()}>
              install skill
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/**
 * A group's band: its name and count on the left, its controls on the right.
 *
 * The heading is part of the band rather than a line of its own. On its own it was a label with
 * tight space above it and loose space below — the two gaps read as though the heading belonged to
 * what was under it either way, but a band gives the controls a row to live in and the page a
 * rhythm: title, band, list, band, list.
 */
function Band({ title, count, right }: { title: string; count: number; right?: React.ReactNode }) {
  return (
    <div className="mt-7 mb-3 flex items-center gap-2">
      <h2 className="flex items-baseline gap-2 text-[13px] font-semibold">
        {title}
        <span className="text-[12px] font-normal" style={{ color: "var(--text-dim)" }}>{count}</span>
      </h2>
      {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
    </div>
  );
}

/** One rounded panel; the rows inside are separated by a hairline rather than drawn as cards. */
function Panel({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <div data-testid={testId} className="overflow-hidden rounded-lg border" style={{ borderColor: "var(--border)" }}>
      {children}
    </div>
  );
}

function Row({ slug, body, children }: { slug: string; body?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div
      data-testid="skill-row"
      data-slug={slug}
      className="border-t px-3 py-2.5 first:border-t-0"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
    >
      <div className="flex items-center gap-3">{children}</div>
      {body}
    </div>
  );
}

/**
 * The left of a row: a disclosure caret, a glyph tile, the name, and the description under it.
 *
 * The name is the control that opens the body — a whole-row click would fight the switch and the
 * delete sitting in it — and the caret is the visible half of that affordance, because a click
 * target nobody can see is a feature only the person who wrote it knows about.
 */
function Identity({
  skill, expanded, onToggleBody,
}: { skill: Skill; expanded: boolean; onToggleBody: () => void }) {
  return (
    <>
      <button
        type="button"
        onClick={onToggleBody}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Hide" : "Show"} instructions for ${skill.name}`}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <Caret open={expanded} />
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md"
          style={{ background: "var(--surface-2)", color: "var(--text-dim)" }}
          aria-hidden="true"
        >
          <SkillGlyph />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px]">{skill.name}</span>
          <span className="block truncate text-[11px]" style={{ color: "var(--text-dim)" }}>
            {skill.description?.trim() || "No description"}
          </span>
        </span>
      </button>
    </>
  );
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true"
      className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
      style={{ color: "var(--text-faint)" }}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function Body({ body }: { body: string }) {
  /**
   * Wrapped, not scrolled sideways. These are instructions to be read, and a procedure whose lines
   * run off the panel edge is read as clipped text — a horizontal scrollbar at the bottom of a box
   * is not a sign anyone notices.
   *
   * Aligned to the description column: caret 12 + gap 12 + tile 36 + gap 12.
   */
  return (
    <pre
      className="mono mt-2 whitespace-pre-wrap break-words rounded p-2 text-[11px] leading-relaxed"
      style={{ background: "var(--bg)", color: "var(--text-dim)", marginLeft: 72 }}
    >
      {body}
    </pre>
  );
}

function Switch({ skill, onToggle }: { skill: Skill; onToggle: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={skill.enabled}
      aria-label={skill.enabled ? `Disable ${skill.name}` : `Enable ${skill.name}`}
      title={skill.enabled ? "Enabled — the agent may load this skill" : "Disabled — the agent will not be offered this skill"}
      onClick={() => onToggle(!skill.enabled)}
      className="relative h-5 w-9 shrink-0 rounded-full transition-colors"
      style={{ background: skill.enabled ? "var(--accent)" : "var(--surface-2)", border: "1px solid var(--border)" }}
    >
      <span
        className={`absolute top-[1px] h-[16px] w-[16px] rounded-full shadow transition-all ${skill.enabled ? "left-[18px]" : "left-[1px]"}`}
        style={{ background: "#fff" }}
      />
    </button>
  );
}

/**
 * Delete asks first, and the question differs by where the skill came from: a builtin is only
 * removed from this install, so it can be had again from the catalog, while the operator's own
 * skill has no other copy and saying otherwise would be a lie about a destructive action.
 */
function DeleteButton({ skill, onAsk }: { skill: Skill; onAsk: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Delete ${skill.name}`}
      title={`Delete ${skill.name}`}
      onClick={onAsk}
      className="shrink-0 rounded p-1.5 transition-opacity hover:opacity-80"
      style={{ color: "var(--text-faint)" }}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
        <path d="M4 7h16M9.5 7V4.5h5V7m-8.5 0 1 13.5h10L18.5 7" />
      </svg>
    </button>
  );
}

function Filter({
  label, value, onChange, options,
}: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <select
      aria-label={label}
      title={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded border px-2 py-1 text-[11px]"
      style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--text-dim)" }}
    >
      {options.map(([v, text]) => (
        <option key={v} value={v}>{text}</option>
      ))}
    </select>
  );
}

function SearchGlyph() {
  return (
    <svg
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
      className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
      style={{ color: "var(--text-faint)" }} aria-hidden="true"
    >
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </svg>
  );
}

/**
 * Sized to be seen. An icon-only control has no label to carry it, so it has to be large enough
 * and heavy enough to read as a control at rest — a 14px glyph at a hairline stroke on a dark
 * background is invisible until someone already knows it is there.
 */
function RefreshGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 5v6h-6" />
    </svg>
  );
}

function SkillGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
      <path d="M12 3.5 13.7 9l5.3 1.7-5.3 1.7L12 18l-1.7-5.6L5 10.7 10.3 9z" />
    </svg>
  );
}

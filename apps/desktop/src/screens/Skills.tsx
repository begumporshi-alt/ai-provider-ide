/**
 * Skills marketplace (P5).
 *
 * The one thing this screen has to be honest about is what a skill is: instructions, not
 * capability. A skill cannot widen the tool surface — the sandbox still allows exactly the four
 * tools in tools.rs. What installing one does is put its instructions into the agent's context,
 * where they will steer how those four tools get used.
 *
 * So the body is shown before install and after it. A marketplace that installs invisible
 * instructions is asking to be trusted on faith, and there is no reason to.
 */
import { useEffect, useMemo, useState } from "react";
import { Button, EmptyState, inputCls, inputStyle } from "../components/atoms";
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

const TRUST_NOTE =
  "A skill is a procedure, not a permission. Installed skills are appended to the agent's system " +
  "prompt and can only use the sandbox tools the agent already has — reading, searching, " +
  "editing and allowlisted commands, confined to the workspace root. A skill cannot grant " +
  "itself anything new. Read the instructions before installing: you are deciding what your " +
  "agent will try to do, not what it is allowed to do.";

export function SkillsScreen() {
  const tick = useUi((s) => s.tick);
  const bump = useUi((s) => s.bump);
  const [installed, setInstalled] = useState<Skill[]>([]);
  const [catalog, setCatalog] = useState<Skill[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [parsed, setParsed] = useState<{ name: string; description: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listSkills(), skillsCatalog()])
      .then(([s, c]) => {
        setInstalled(s);
        setCatalog(c);
      })
      .catch(() => undefined);
  }, [tick]);

  const installedSlugs = useMemo(() => new Set(installed.map((s) => s.slug)), [installed]);
  const available = useMemo(() => catalog.filter((c) => !installedSlugs.has(c.slug)), [catalog, installedSlugs]);

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

  async function doRevoke(slug: string) {
    setError(null);
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
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-3 flex items-baseline gap-3">
        <h1 className="text-[20px] font-semibold">Skills</h1>
        <span className="text-[12px]" style={{ color: "var(--text-dim)" }}>
          {installed.length} installed · {installed.filter((s) => s.enabled).length} active
        </span>
      </div>

      <p className="mb-4 rounded border p-2.5 text-[11px] leading-relaxed" style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--text-dim)" }}>
        {TRUST_NOTE}
      </p>

      {error && (
        <p className="mb-3 text-[12px]" style={{ color: "var(--danger)" }}>{error}</p>
      )}

      <Section title="Installed">
        {installed.length === 0 ? (
          <EmptyState title="No skills installed. Add one from the catalog below, or paste your own." />
        ) : (
          <div>
            {installed.map((s) => (
              <div key={s.slug} className="mb-1.5 rounded border" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
                <div className="flex items-center gap-2 px-3 py-2">
                  <button className="min-w-0 flex-1 text-left" onClick={() => setOpen(open === s.slug ? null : s.slug)}>
                    <span className="text-[13px]">{s.name}</span>
                    <span className="ml-2 text-[11px]" style={{ color: "var(--text-dim)" }}>{s.description}</span>
                  </button>
                  <span className="mono rounded px-1.5 py-0.5 text-[10px]" style={{ background: "var(--surface-2)", color: "var(--text-dim)" }}>
                    {s.source}
                  </span>
                  <label className="flex cursor-pointer items-center gap-1 text-[11px]" style={{ color: "var(--text-dim)" }}>
                    <input type="checkbox" checked={s.enabled} onChange={(e) => doToggle(s.slug, e.target.checked)} />
                    active
                  </label>
                  <button className="text-[11px]" style={{ color: "var(--danger)" }} onClick={() => doRevoke(s.slug)}>
                    revoke
                  </button>
                </div>
                {open === s.slug && (
                  <pre className="mono overflow-x-auto border-t px-3 py-2 text-[11px] leading-relaxed" style={{ borderColor: "var(--border)", color: "var(--text-dim)" }}>
                    {s.body}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Catalog">
        {available.length === 0 ? (
          <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>Every builtin skill is installed.</p>
        ) : (
          <div>
            {available.map((s) => (
              <div key={s.slug} className="mb-1.5 flex items-start gap-2 rounded border px-3 py-2" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px]">{s.name}</div>
                  <div className="text-[11px]" style={{ color: "var(--text-dim)" }}>{s.description}</div>
                  {open === `cat:${s.slug}` && (
                    <pre className="mono mt-2 overflow-x-auto text-[11px] leading-relaxed" style={{ color: "var(--text-dim)" }}>{s.body}</pre>
                  )}
                </div>
                <button className="text-[11px]" style={{ color: "var(--text-faint)" }} onClick={() => setOpen(open === `cat:${s.slug}` ? null : `cat:${s.slug}`)}>
                  {open === `cat:${s.slug}` ? "hide" : "read"}
                </button>
                <Button onClick={() => doInstall({ slug: s.slug, name: s.name, description: s.description, body: s.body })}>install</Button>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Add your own">
        <p className="mb-2 text-[11px]" style={{ color: "var(--text-faint)" }}>
          Paste a SKILL.md — optional frontmatter (<code className="mono">name:</code> and <code className="mono">description:</code>) above a <code className="mono">---</code> line, then the instructions.
        </p>
        <textarea
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setParsed(null);
          }}
          onBlur={doParseDraft}
          rows={8}
          placeholder={"---\nname: My Skill\ndescription: what it is for\n---\n1. Read the file.\n2. Do the thing.\n3. Report what you found."}
          className={`${inputCls} mono w-full`}
          style={{ ...inputStyle, resize: "vertical" }}
        />
        {parsed && (
          <div className="mt-2 rounded border p-2 text-[11px]" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
            <div><b>{parsed.name || "(name inferred from the slug)"}</b> — {parsed.description || "(no description)"}</div>
            <div className="mt-1" style={{ color: "var(--text-faint)" }}>{parsed.body.length} characters of instructions</div>
          </div>
        )}
        <div className="mt-2">
          <Button onClick={doInstallDraft} disabled={!draft.trim()}>install skill</Button>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-widest" style={{ color: "var(--text-faint)" }}>
        {title}
      </h2>
      {children}
    </div>
  );
}

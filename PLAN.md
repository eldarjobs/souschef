# souschef — plan

**Məqsəd:** Claude Code (və istənilən MCP client) işi bitirəndə test yazmağı **ikinci bir agentə** —
əvvəlcə Antigravity CLI-yə (`agy`) — ötürsün, onu real vaxtda izləsin, nəticəni strukturlaşdırılmış
şəkildə geri alsın və lazım olsa eyni söhbətdə düzəliş istəsin. SkyChef-ə bağlı deyil: hər layihədə işləyir.

## Necə görünəcək

```
Claude                        souschef (MCP server)                 agy
──────                        ────────────────────────                 ───
start_run(feature, reqs) ───▶ run qovluğu + brief.md yazır
                              agy -p "brief.md-ni oxu" ─────────────▶  test yazır, test işə salır
◀── run_id                    git status-u hər 3 saniyədə yoxlayır
wait_run(run_id) ───────────▶ hadisələr: FILE …, exited, result
◀── events + state            (state bitəndə: result + guard)
   … dövrlə …                                                         result.json yazır
◀── state=failed, suspected_source_bugs
Claude kodu düzəldir
continue_run(run_id, "düzəltdim, yenidən işlət") ─▶ agy --conversation <id> (eyni söhbət)
```

## Yoxlanmış faktlar (2026-10-22, agy 1.0.0)

- `agy -p <prompt>` headless işləyir, cavabı **yalnız sonda** çap edir. Gedişat stdout-dan yox,
  fayl sistemindən izlənməlidir.
- `--dangerously-skip-permissions`: tool icazələri avtomatik verilir. Bu olmadan heç kim
  baxmayanda agy işləyə bilmir.
- `--print-timeout` default 5 dəqiqədir, testlər üçün qaldırılmalıdır.
- `--log-file`: söhbət ID-si logda yazılır (`Created conversation <uuid>`), sonra
  `--conversation <uuid>` ilə həmin söhbət davam etdirilir.
- Logdakı "You are not logged into Antigravity" sətirləri login olanda da çıxır. Auth problemini
  boş cavab göstərir, log yox.
- agy işlədiyi qovluqda boş `logs/` qovluğu yaradır. Run bitəndə əvvəl yox idisə və boşdursa, silinir.
- agy-yə qoşulan MCP-lər (məsələn, Serena) layihədə öz fayllarını yarada bilər (`.serena/`). Guard bunları
  `out_of_scope` kimi göstərir. Bu düzgündür: həmin dəyişikliyi agent edib.
- Windows-da `os.tmpdir()` 8.3 qısa yol qaytarır (`LONGNA~1`), git isə uzun yol. Root
  `realpathSync.native` ilə açılmasa, bütün fayllar səhvən "out of scope" görünür (düzəldilib).

## Uçdan-uca yoxlama (2026-10-22, `npm run smoke`)

Qəsdən bug qoyulmuş Node layihəsində (`isEven` → `n % 2 === 1`) bu ardıcıllıq yoxlanılıb:
start_run → wait_run → `failed 4/7`, `suspected_source_bugs: src/math.js` (agy bug-ı düzgün tapdı) →
kod düzəldildi → continue_run (eyni söhbət: `--conversation`) → `passed 7/7`. Birinci run 2.1 dəqiqə,
ikincisi 0.6 dəqiqə çəkdi.

## Komponentlər

| Hissə | Nə edir |
|---|---|
| `src/` (TypeScript) | MCP server. esbuild ilə tək fayla yığılır: `plugin/dist/server.cjs`. Asılılığı yoxdur, `npm install` lazım deyil. |
| `plugin/` | Claude Code plugin: manifest, skill, slash command, yığılmış server. |
| `.claude-plugin/marketplace.json` | Repo özü marketplace-dir: `/plugin marketplace add <repo>`. |

### MCP alətləri

| Alət | Giriş | Çıxış |
|---|---|---|
| `doctor` | adapter, ping | binary, versiya, auth (PONG testi), layihədə aşkarlanan test əmri və qovluqlar |
| `start_run` | feature, requirements[], changed_files[], test_command?, write_globs?, timeout_minutes? | run_id, run qovluğu |
| `wait_run` | run_id, cursor, max_wait_seconds (default 120) | state, elapsed, yeni hadisələr, cursor; bitəndə: result + guard |
| `continue_run` | run_id, feedback | yeni run_id (eyni agy söhbəti) |
| `cancel_run` | run_id | proses ağacı öldürülür (yalnız öz PID-i ilə) |
| `list_runs` | limit | son run-lar və vəziyyətləri |

### Run qovluğu — `<layihə>/.souschef/runs/<run_id>/`

`task.json`, `brief.md` (agentə gedən təlimat), `events.jsonl`, `state.json`, `agent.out.txt`,
`agent.err.txt`, `agent.log`, `result.json`. `.souschef/` özünü `.gitignore` edir, layihənin
`.gitignore`-una toxunulmur.

### Nəticə müqaviləsi (agent yazır)

`status` (passed | failed | error), `tests_added[]`, `command`, `summary{total,passed,failed,skipped}`,
`failures[]`, `suspected_source_bugs[]`, `uncovered_requirements[]`, `notes`.
Server buna `guard.out_of_scope[]`-u əlavə edir: icazə verilən qovluqlardan kənarda dəyişən fayllar.

### Layihə konfiqi — `.souschef.json` (opsional)

```json
{
  "adapter": "agy",
  "test_command": "dotnet test ...",
  "write_globs": ["SkyChef/Tests/**"],
  "rules": ["SqlServer kateqoriyalı test yazma"],
  "timeout_minutes": 60
}
```

Konfiq olmasa, test əmri və qovluqlar layihədən aşkarlanır: `*.sln/*.csproj` → `dotnet test`,
`package.json` → `npm|pnpm|yarn test`, `pyproject.toml/pytest.ini` → `pytest`, `go.mod` → `go test ./...`,
`Cargo.toml` → `cargo test`.

## Təhlükəsizlik

- Agent yalnız `write_globs` daxilində yazmalıdır: bu brief-də deyilir, run bitəndə isə git diff ilə
  yoxlanılır. Pozuntu nəticədə `guard.out_of_scope` kimi qayıdır. Avtomatik geri qaytarılmır, çünki
  checkout-u başqaları da paylaşa bilər.
- Agent git vəziyyətini dəyişmir (commit/stash/reset yoxdur) və proses öldürmür.
- Proseslər yalnız öz PID-i ilə öldürülür, adla heç vaxt.

## Fazalar

**Faza 1 — MVP (indi):** agy adapteri, 6 alət, skill + `/souschef:taste`, marketplace manifesti,
kiçik layihədə uçdan-uca test (start → wait → continue), SkyChef-in bu plugin-ə keçirilməsi.

**Faza 2:**
- `gemini -p` və `codex exec` adapterləri.
- `isolation: "worktree"`: agent ayrıca git worktree-də işləyir, nəticə patch kimi qayıdır.
- Test prosesinin aşkarlanması ("dotnet test işləyir").
- localhost-da canlı run paneli.

**Faza 3:** GitHub-a public repo, npm paketi (`npx souschef`, Cursor/Codex üçün), README demo.

## Quraşdırma (hədəf)

```
/plugin marketplace add eldarjobs/souschef
/plugin install souschef@souschef
```

Lokal sınaq üçün: `claude plugin marketplace add <bu qovluğun yolu>`

# Graph Report - mu  (2026-10-31)

## Corpus Check
- 145 files · ~74,657 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 26 file(s) not represented in the graph (top: .css 15, (none) 7, .lock 2)

## Summary
- 1277 nodes · 2339 edges · 115 communities (82 shown, 33 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 70 edges (avg confidence: 0.9)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Worker Runtime and Hardware
- Server Connection Settings
- Legacy Action Handlers
- CLI Entry Commands
- Worker Integration Tests
- Legacy Task Scheduling
- Minimal Spec Structure
- HTTP Action Configuration
- Workspace Request Actions
- Spec Notification Hooks
- Request Artifact Views
- Pipeline Graph Editors
- Spec Workspace Layout
- Request Payload Editing
- Legacy Condition Validators
- Node Action Configuration
- Entry Initialization Hooks
- Frontend Runtime Dependencies
- Spec Lifecycle Editors
- Frontend TypeScript Configuration
- Media Parameter Defaults
- Frontend Build Dependencies
- Tauri Window Configuration
- Backend Authentication Guards
- Legacy Spec Validation
- Backend TypeScript Configuration
- Password Authentication Setup
- Native Profile Storage
- Workload HTTP Actions
- Request Backend Mutations
- Desktop Sign In
- Artifact Upload Receipts
- YAML Code Editor
- Date and Select Inputs
- Indexed Request Selection
- Worker HTTP Contract
- GPU Hardware Detection
- Spec Validation Workflow
- Request DAG Semantics
- Workload Execution Arguments
- HTTP Response State
- Worker HTTP Routing
- CLI Lifecycle Contract
- Scheduler Smoke Pipeline
- Workload Parameter Schema
- Worker Token Management
- Desktop Notification Delivery
- Node Lifecycle Actions
- Spec Reference Examples
- Guarded HTTP Actions
- Media Model Workloads
- MasterFlow Data Invariants
- Artifact Schema Types
- Execution Presentation Tests
- Spec Model Tests
- Runtime Scheduling Semantics
- Node Before Actions
- Text Artifact Workload
- Media Pipeline Workloads
- Conditional Before Actions
- Pipeline Preparation Actions
- MasterFlow Storage Architecture
- Request Editor Tests
- Worker API Tests
- YAML Diagnostic Tests
- Node Finally Actions
- Generated Convex Contexts
- Artifact Download Contract
- Date Time Tests
- Bun TypeScript Configuration
- Workspace Repository Ownership
- Request Scheduling Workflow
- Node Dependency Conditions
- Runtime Context Stages
- Node Postcondition Checks
- Local Deployment Workflow
- Tauri Capability Permissions
- Explicit Smoke Reporting
- Audio Separation Workload
- Frontend Build Scripts
- Node Workload Invocation
- Media Artifact Example
- Test HTTP Setup
- Web Application Entry
- CodeMirror Command Package
- CodeMirror Lint Package
- CodeMirror Search Package
- CodeMirror State Package
- CodeMirror Dark Theme
- CodeMirror View Package
- Native Notification Plugin
- YAML Parser Package
- TypeScript Compiler Package
- Tauri Brand Logo
- Vite Brand Logo
- React Brand Logo
- Application Branding Assets
- Application Branding Assets
- Application Branding Assets
- Application Branding Assets
- Application Branding Assets
- Application Branding Assets
- Application Branding Assets
- Application Branding Assets
- Application Branding Assets
- Application Branding Assets
- Application Branding Assets
- Application Branding Assets
- Application Branding Assets
- Application Branding Assets
- MU CLI Package
- MasterFlow Application Package

## God Nodes (most connected - your core abstractions)
1. `App()` - 37 edges
2. `requireAuthenticated()` - 29 edges
3. `react` - 25 edges
4. `convex` - 24 edges
5. `Input` - 24 edges
6. `ComputeDevice` - 21 edges
7. `run()` - 20 edges
8. `RuntimeError` - 20 edges
9. `execute_pipelines()` - 19 edges
10. `_render()` - 18 edges

## Surprising Connections (you probably didn't know these)
- `No automatic reporting claim` --conceptually_related_to--> `Automatic reporting claim`  [AMBIGUOUS]
  mu-cli/docs/spec-format/07-master-flow-and-cli.md → mu-masterflow/docs/worker-hooks.md
- `Request artifact protocol` --semantically_similar_to--> `Upload receipt protocol`  [INFERRED] [semantically similar]
  mu-cli/docs/spec-format/07-master-flow-and-cli.md → mu-masterflow/docs/request-artifacts.md
- `No automatic reporting claim` --conceptually_related_to--> `Automatic reporting claim`  [AMBIGUOUS]
  mu-cli/docs/spec-format/07-master-flow-and-cli.md → mu-cli/docs/request-to-node-scheduling.md
- `Strict parameter schema` --conceptually_related_to--> `Payload edit conflict`  [INFERRED]
  mu-cli/docs/spec-format/02-context-and-templates.md → mu-masterflow/docs/spec-yaml.md
- `Archived creation claim` --conceptually_related_to--> `Archived creation claim`  [AMBIGUOUS]
  mu-masterflow/docs/worker-hooks.md → mu-masterflow/docs/request-artifacts.md

## Import Cycles
- None detected.

## Communities (115 total, 33 thin omitted)

### Community 0 - "Worker Runtime and Hardware"
Cohesion: 0.08
Nodes (23): ComputeDevice, request_headers(), _render(), _apply_context(), condition(), _execute_node(), execute_pipeline(), execute_pipelines() (+15 more)

### Community 1 - "Server Connection Settings"
Cohesion: 0.08
Nodes (36): ConnectionController(), ConnectionControllerProps, DisconnectedRoot(), DisconnectedRootProps, LoginServerDialog(), editProfile(), removeProfile(), saveServer() (+28 more)

### Community 2 - "Legacy Action Handlers"
Cohesion: 0.10
Nodes (18): ActionError, command_action(), create_dir_action(), register_action(), _render(), lookup(), replace(), run_action() (+10 more)

### Community 3 - "CLI Entry Commands"
Cohesion: 0.11
Nodes (20): _execute_flow(), interrupt(), _load_runtime_spec(), master_flow_run(), models(), plan(), _print_plan_report(), _print_run_report() (+12 more)

### Community 4 - "Worker Integration Tests"
Cohesion: 0.08
Nodes (6): FlowTests, assert_auth(), do_GET(), do_POST(), write(), HttpFileTests

### Community 5 - "Legacy Task Scheduling"
Cohesion: 0.13
Nodes (7): _choose_device(), execute_tasks(), _run_one(), _check_acyclic(), visit(), Scheduler, TaskGraphError

### Community 6 - "Minimal Spec Structure"
Cohesion: 0.07
Nodes (28): entries, context, nodes, params, args, params, target, units (+20 more)

### Community 7 - "HTTP Action Configuration"
Cohesion: 0.07
Nodes (26): args, body, body_file, content, header, method, path, response_file (+18 more)

### Community 8 - "Workspace Request Actions"
Cohesion: 0.12
Nodes (17): App(), addSpec(), archiveSpec(), changeWholeSpec(), deleteRequest(), notice(), resetRequest(), saveRequest() (+9 more)

### Community 9 - "Spec Notification Hooks"
Cohesion: 0.09
Nodes (24): message, title, nodes, params, entries, master_flow, body, header (+16 more)

### Community 10 - "Request Artifact Views"
Cohesion: 0.16
Nodes (15): RequestArtifacts(), RequestArtifactsProps, RequestActions(), RequestExecution(), RequestsView(), RequestsViewProps, labels, Status() (+7 more)

### Community 11 - "Pipeline Graph Editors"
Cohesion: 0.22
Nodes (17): DependencyGraph(), DependencyGraphProps, PipelineEditor(), PipelineEditorProps, SpecOverview(), Value(), nodePresentation(), requestExecutionSummary() (+9 more)

### Community 12 - "Spec Workspace Layout"
Cohesion: 0.11
Nodes (10): AppProps, RequestEditorSession, SectionTabs(), SpecHeader(), SpecHeaderProps, SpecSidebarProps, starterYaml, tabs (+2 more)

### Community 13 - "Request Payload Editing"
Cohesion: 0.21
Nodes (15): Props, RequestEditor(), changePipeline(), currentPayload(), submit(), switchMode(), draftPayload(), InputDraft (+7 more)

### Community 14 - "Legacy Condition Validators"
Cohesion: 0.24
Nodes (9): exit_code(), exit_one(), exit_zero(), file_existed(), register_check(), _render(), validate_action_checks(), ValidationError (+1 more)

### Community 15 - "Node Action Configuration"
Cohesion: 0.10
Nodes (19): args, target, type, nodes, content, path, precondition, type (+11 more)

### Community 16 - "Entry Initialization Hooks"
Cohesion: 0.12
Nodes (20): message, title, initialization, entries, direct_flow, master_flow, body, header (+12 more)

### Community 17 - "Frontend Runtime Dependencies"
Cohesion: 0.10
Nodes (20): dependencies, convex@^1.48.0, @convex-dev/auth@0.0.96, jose@^6.2.14, @radix-ui/react-dropdown-menu@^2.2.1, @radix-ui/react-popover@^1.3.1, @radix-ui/react-select@^2.4.1, react@^19.1.0 (+12 more)

### Community 18 - "Spec Lifecycle Editors"
Cohesion: 0.19
Nodes (14): EntriesEditor(), Props, labelFor(), field(), CreateDialog(), RenameDialog(), SpecDialogs(), SpecDialogsProps (+6 more)

### Community 19 - "Frontend TypeScript Configuration"
Cohesion: 0.11
Nodes (18): compilerOptions, allowImportingTsExtensions, isolatedModules, jsx, lib, module, moduleResolution, noEmit (+10 more)

### Community 20 - "Media Parameter Defaults"
Cohesion: 0.12
Nodes (18): default, type, type, default, type, type, type, cover_height (+10 more)

### Community 21 - "Frontend Build Dependencies"
Cohesion: 0.15
Nodes (16): devDependencies, @tauri-apps/cli@^2, @types/react@^19.1.8, @types/react-dom@^19.1.6, vite@^8.0.16, @vitejs/plugin-react@^6.0.2, name, packageManager (+8 more)

### Community 22 - "Tauri Window Configuration"
Cohesion: 0.11
Nodes (17): app, security, windows, build, beforeBuildCommand, beforeDevCommand, devUrl, frontendDist (+9 more)

### Community 23 - "Backend Authentication Guards"
Cohesion: 0.20
Nodes (12): requireAuthenticated(), mutation, create, list, markRead, remove, create, getYaml (+4 more)

### Community 24 - "Legacy Spec Validation"
Cohesion: 0.22
Nodes (4): load_spec(), repair_spec(), SpecError, validate_spec()

### Community 25 - "Backend TypeScript Configuration"
Cohesion: 0.12
Nodes (15): compilerOptions, allowJs, allowSyntheticDefaultImports, forceConsistentCasingInFileNames, isolatedModules, jsx, lib, module (+7 more)

### Community 26 - "Password Authentication Setup"
Cohesion: 0.15
Nodes (12): auth, isAuthenticated, registrationAvailable, signIn, signOut, store, action, env (+4 more)

### Community 27 - "Native Profile Storage"
Cohesion: 0.23
Nodes (5): connection_settings_path(), ConnectionProfile, ConnectionSettings, load_connection_settings(), save_connection_settings()

### Community 28 - "Workload HTTP Actions"
Cohesion: 0.14
Nodes (14): run, args, body, body_file, header, method, postcondition, save_state (+6 more)

### Community 29 - "Request Backend Mutations"
Cohesion: 0.20
Nodes (13): isArtifactArray(), canonicalPayload(), create, createArgs, createFromWorker, createRequest(), editPayload, list (+5 more)

### Community 30 - "Desktop Sign In"
Cohesion: 0.19
Nodes (8): api, components, internal, AuthenticatedRoot(), AuthenticatedRootProps, SignInForm(), SignInFormProps, @convex-dev/auth

### Community 31 - "Artifact Upload Receipts"
Cohesion: 0.22
Nodes (13): complete(), completeArgs, completeFromWorker, completeUpload, digestHex(), getForWorker, start(), startArgs (+5 more)

### Community 32 - "YAML Code Editor"
Cohesion: 0.18
Nodes (9): @codemirror/lang-yaml@^6.1.3, @codemirror/language@^6.13.1, ConfigEditor, ConfigEditor(), ConfigEditorProps, YamlProblem, yamlProblems(), @codemirror/lang-yaml (+1 more)

### Community 33 - "Date and Select Inputs"
Cohesion: 0.26
Nodes (7): CalendarCaption(), DateTimePicker(), apply(), SelectField(), SelectOption, formatLocalDateTime(), parseLocalDateTime()

### Community 34 - "Indexed Request Selection"
Cohesion: 0.21
Nodes (10): internalMutation, inspect, requestStatus, Selection, selectionArgs, selectOne(), selectRequests(), claim (+2 more)

### Community 35 - "Worker HTTP Contract"
Cohesion: 0.15
Nodes (11): Archived creation claim, Atomic claim endpoint, Automatic reporting claim, Heartbeat endpoint, HTTP contract, Notification endpoint, Public health, Report endpoint (+3 more)

### Community 36 - "GPU Hardware Detection"
Cohesion: 0.29
Nodes (5): detect_devices(), _detect_nvidia(), _detect_rocm(), linux_integrated_gpu_names(), _run()

### Community 37 - "Spec Validation Workflow"
Cohesion: 0.18
Nodes (8): Dependency validation, Spec creation workflow, Condition operators, node_state, node_status, Node ignore_error, Sequential phases, Skipped node postcondition

### Community 38 - "Request DAG Semantics"
Cohesion: 0.17
Nodes (10): Strict parameter schema, Dependency DAG, Requests table, Automatic reporting claim, DAG visualization, Ended node uncertainty, Failed request reset, Payload edit conflict (+2 more)

### Community 39 - "Workload Execution Arguments"
Cohesion: 0.17
Nodes (11): args, target, units, entries, master_flow, args, target, units (+3 more)

### Community 40 - "HTTP Response State"
Cohesion: 0.17
Nodes (12): args, body, body_file, header, method, response_file, save_state, target (+4 more)

### Community 41 - "Worker HTTP Routing"
Cohesion: 0.21
Nodes (7): NodeUpdate, http, jsonHeaders, options, parseSelection(), requiredString(), selectionFilter()

### Community 42 - "CLI Lifecycle Contract"
Cohesion: 0.20
Nodes (7): Current and legacy runtimes, Runtime invariants, Entry lifecycle, Lazy preparation, Remote worker lifecycle, MU CLI, Safe CLI validation

### Community 43 - "Scheduler Smoke Pipeline"
Cohesion: 0.18
Nodes (11): artifact_path, downloaded_path, context, depends_on, name, postcondition, pipeline, scheduler-smoke (+3 more)

### Community 44 - "Workload Parameter Schema"
Cohesion: 0.20
Nodes (11): params, type, type, input, output, args, device_args, params (+3 more)

### Community 45 - "Worker Token Management"
Cohesion: 0.22
Nodes (9): create, get, getByHash, list, markUsed, revoke, tokenInfo, toTokenInfo() (+1 more)

### Community 46 - "Desktop Notification Delivery"
Cohesion: 0.29
Nodes (6): NotificationItem, NotificationsView(), enableNotifications(), enableSystemNotifications(), sendSystemNotification(), systemNotificationsEnabled()

### Community 47 - "Node Lifecycle Actions"
Cohesion: 0.20
Nodes (9): Action guards, execute_workload, Finally cleanup, No action aliases, Saved action state, send_http_request, action_state, Request artifact protocol (+1 more)

### Community 48 - "Spec Reference Examples"
Cohesion: 0.20
Nodes (5): Corrected workload example, CPU text rendering example, Independent request outputs, Spec quick reference, Spec is data

### Community 49 - "Guarded HTTP Actions"
Cohesion: 0.20
Nodes (10): body, content, header, ignore_error, method, path, precondition, type (+2 more)

### Community 50 - "Media Model Workloads"
Cohesion: 0.20
Nodes (10): request, score, type, type, yue2, args, device_args, params (+2 more)

### Community 51 - "MasterFlow Data Invariants"
Cohesion: 0.22
Nodes (7): Atomic indexed claim, First account registration, MasterFlow invariants, Request reset, Separate authentication, Agent guide pointer, MasterFlow desktop

### Community 52 - "Artifact Schema Types"
Cohesion: 0.29
Nodes (6): Artifact, DataModel, Doc, Id, TableNames, convex

### Community 53 - "Execution Presentation Tests"
Cohesion: 0.20
Nodes (7): assert, ex, fs, nodes, path, {test}, ts

### Community 54 - "Spec Model Tests"
Cohesion: 0.20
Nodes (8): assert, fs, { nodeDependencyNames, starterYaml }, { parse }, path, { specIssues, nextName, renameNode, requestPayload }, { test }, ts

### Community 55 - "Runtime Scheduling Semantics"
Cohesion: 0.22
Nodes (6): Node lifecycle, Spec lifecycle, Argv execution, CPU fallback, GPU scheduling units, Reusable workload

### Community 56 - "Node Before Actions"
Cohesion: 0.22
Nodes (9): body, content, header, ignore_error, method, path, type, url (+1 more)

### Community 57 - "Text Artifact Workload"
Cohesion: 0.22
Nodes (9): args, params, target, units, type, output_path, request_id, type (+1 more)

### Community 58 - "Media Pipeline Workloads"
Cohesion: 0.22
Nodes (8): pipeline, song-with-cover, args, device_args, target, units, workloads, qwen-image

### Community 59 - "Conditional Before Actions"
Cohesion: 0.22
Nodes (9): body, content, header, ignore_error, method, path, type, url (+1 more)

### Community 60 - "Pipeline Preparation Actions"
Cohesion: 0.22
Nodes (9): args, save_state, skip_if, target, type, operator, path, target (+1 more)

### Community 61 - "MasterFlow Storage Architecture"
Cohesion: 0.22
Nodes (8): Artifact receipts, Authoritative specs table, Local server profiles, Reactive desktop architecture, Reset version guard, Shared UI primitives, Unit token model, Verified completion

### Community 62 - "Request Editor Tests"
Cohesion: 0.22
Nodes (8): assert, fs, {inputDrafts,draftPayload,payloadIssues,requestTitle}, load(), path, schema, {test}, ts

### Community 63 - "Worker API Tests"
Cohesion: 0.22
Nodes (6): assert, fs, path, { test }, ts, { webcrypto }

### Community 64 - "YAML Diagnostic Tests"
Cohesion: 0.22
Nodes (8): assert, fs, load(), path, { starterYaml }, { test }, ts, { yamlProblems }

### Community 65 - "Node Finally Actions"
Cohesion: 0.25
Nodes (8): body, header, ignore_error, method, precondition, type, url, finally

### Community 66 - "Generated Convex Contexts"
Cohesion: 0.25
Nodes (6): ActionCtx, DatabaseReader, DatabaseWriter, Env, MutationCtx, QueryCtx

### Community 67 - "Artifact Download Contract"
Cohesion: 0.25
Nodes (7): Archived creation claim, Authenticated byte downloads, Bearer download links, Exact report references, Idempotent replacement, Request artifact ownership, Retention

### Community 68 - "Date Time Tests"
Cohesion: 0.25
Nodes (5): assert, exports_, fs, { test }, ts

### Community 69 - "Bun TypeScript Configuration"
Cohesion: 0.25
Nodes (7): compilerOptions, allowSyntheticDefaultImports, composite, module, moduleResolution, skipLibCheck, include

### Community 70 - "Workspace Repository Ownership"
Cohesion: 0.29
Nodes (4): Repository ownership, Submodule integration, Canonical documentation, MU workspace

### Community 71 - "Request Scheduling Workflow"
Cohesion: 0.29
Nodes (6): Automatic reporting claim, Concurrency limit, Node GPU admission, Preparation boundary, Request scheduler, Full node reservation

### Community 72 - "Node Dependency Conditions"
Cohesion: 0.29
Nodes (7): depends_on, name, precondition, expected, operator, target, nodes

### Community 73 - "Runtime Context Stages"
Cohesion: 0.33
Nodes (5): Action context scope, Assigned node device, Context stages, MasterFlow session, Typed rendering

### Community 74 - "Node Postcondition Checks"
Cohesion: 0.47
Nodes (6): postcondition, operator, path, props, target, postcondition

### Community 75 - "Local Deployment Workflow"
Cohesion: 0.33
Nodes (5): Deployment auth setup, Self-hosted endpoints, Spec structural validation, Storage backup, Validation workflow

### Community 76 - "Tauri Capability Permissions"
Cohesion: 0.33
Nodes (5): description, identifier, permissions, $schema, windows

### Community 77 - "Explicit Smoke Reporting"
Cohesion: 0.40
Nodes (4): No automatic reporting claim, Artifact round trip, Explicit node reports, Simulated GPU smoke

### Community 78 - "Audio Separation Workload"
Cohesion: 0.40
Nodes (5): args, device_args, target, units, demucs

### Community 79 - "Frontend Build Scripts"
Cohesion: 0.40
Nodes (5): scripts, build, dev, preview, tauri

### Community 80 - "Node Workload Invocation"
Cohesion: 0.50
Nodes (4): run, args, type, workload

### Community 81 - "Media Artifact Example"
Cohesion: 0.50
Nodes (3): Cached output upload, Explicit request reports, Media artifact workflow

## Ambiguous Edges - Review These
- `Automatic reporting claim` → `No automatic reporting claim`  [AMBIGUOUS]
  mu-cli/docs/spec-format/07-master-flow-and-cli.md · relation: conceptually_related_to
- `No automatic reporting claim` → `Automatic reporting claim`  [AMBIGUOUS]
  mu-cli/docs/spec-format/07-master-flow-and-cli.md · relation: conceptually_related_to
- `Archived creation claim` → `Archived creation claim`  [AMBIGUOUS]
  mu-masterflow/docs/worker-hooks.md · relation: conceptually_related_to

## Knowledge Gaps
- **105 isolated node(s):** `mu`, `mu-masterflow`, `Repository ownership`, `Submodule integration`, `MU workspace` (+100 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 609 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **33 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `convex` connect `Artifact Schema Types` to `Server Connection Settings`, `Generated Convex Contexts`, `Indexed Request Selection`, `Worker HTTP Routing`, `Request Artifact Views`, `Spec Workspace Layout`, `Worker Token Management`, `Desktop Notification Delivery`, `Frontend Runtime Dependencies`, `Frontend Build Dependencies`, `Backend Authentication Guards`, `Password Authentication Setup`, `Request Backend Mutations`, `Desktop Sign In`, `Artifact Upload Receipts`?**
  _High betweenness centrality (0.050) - this node is a cross-community bridge._
- **What connects `mu`, `mu-masterflow`, `Repository ownership` to the rest of the system?**
  _105 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Worker Runtime and Hardware` be split into smaller, more focused modules?**
  _Cohesion score 0.08243727598566308 - nodes in this community are weakly interconnected._
- **Why does `App()` connect `Workspace Request Actions` to `YAML Code Editor`, `Server Connection Settings`, `Request Artifact Views`, `Pipeline Graph Editors`, `Spec Workspace Layout`, `Request Payload Editing`, `Desktop Notification Delivery`, `Spec Lifecycle Editors`, `Desktop Sign In`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **Should `Server Connection Settings` be split into smaller, more focused modules?**
  _Cohesion score 0.08144796380090498 - nodes in this community are weakly interconnected._

### Low-confidence Hints
_AMBIGUOUS edges — the extractor was unsure. Verify before acting on these._

- **What is the exact relationship between `Automatic reporting claim` and `No automatic reporting claim`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `No automatic reporting claim` and `Automatic reporting claim`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
## Extraction limitations

Token usage is unavailable from the subagent tools; reported zero counters are placeholders, not measured usage. All 28 documents and 17 images were inspected. Eight code files yielded no symbols. Detection skipped `mu-masterflow/src/unit-tokens.css` as sensitive.

Integrity warning: 157 dangling-endpoint edges, 14 self-loops, and 565 collapsed undirected edge records (561 directed same-endpoint records). These reflect extraction and simple-graph limitations; the map is incomplete.

PNG assets were visually inspected; text line-count coverage does not apply to binary images.

`graphify-out/` was written into the working tree and is currently untracked. Add it to `.gitignore` or commit only outputs the team should share; see https://docs.graphify.com/guides/team-workflows.

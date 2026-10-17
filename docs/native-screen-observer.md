# Optional native screen observation

`codex_screen_observe` is a read-only Native2 tool. It requires an explicitly configured Swift reader endpoint and a fresh reader grant from the configured native tool in the current active turn. Filesystem access, a historical lease, or a tool name in a saved transcript does not authorize observation. Swift remains the input owner.

The optional application setting has two fields:

```json
{
  "nativeScreenObserver": {
    "readerPipe": "\\\\.\\pipe\\example_observer_v1",
    "grantWireName": "mcp__computer_use_swift__swift_observer_reader_grant"
  }
}
```

The pipe must be a local Windows named pipe ending in `_observer_v1`. Generated startup forwards this pair only for explicitly configured Full/automatic Windows operation. Default, safe and browser-only startup leave the observer disabled. Configuration and tool advertisement alone do not create a grant or start a controller. This development work does not change an installed profile or production service.

After obtaining the real grant, an observation may request `tree_format: "compact"`, `"json"` or `"both"`. Omitting this option preserves the existing response. Formatting runs after strict native target, viewport, frame, source and current-turn checks; it sends no formatting argument to the native controller and makes no additional capture call. The original observation status, nodes and source receipts remain available.

The additional `tree` is bounded by depth, node count and its serialized UTF-8 byte budget. Its IDs are ephemeral observation identifiers. Source groups are structural organization; genuine UIA parent links are distinguished from that grouping. OCR/CV regions do not become native controls. Provider patterns and recognized labels are observations and confer no permission to act. Compact labels are quoted and control-escaped; JSON and compact forms describe the same selected nodes when requested together. Truncation or missing providers cannot prove that a control is absent.

The tree's `truncated` flag describes projection limits. Check `sources` for native partial/truncated results even when the projection fits. The derived tree omits redacted UIA provider identities and references to those identities, retaining ephemeral parent links where valid. The original native `nodes` remain unchanged; this formatting option does not sanitize that legacy payload.

OCR/CV use the validated frame and generation. UIA is interval evidence sampled separately; its pixel correspondence remains `unverified`. A READY receipt does not establish atomic UIA/pixel correspondence or successful Web image delivery.

Observer image mode remains **disabled**. `image_delivery_status: "UNAVAILABLE"` is explicit. There is no screenshot-composer, clipboard, screenshot-key or viewer fallback. Native/SDK fixture results and local serialization tests do not establish that a Web model received pixels, that a live DEV tunnel loaded this source, or that the feature works in arbitrary applications. Full campaign acceptance is tracked separately in the Day-10 requirement matrix.

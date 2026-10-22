# Project sidebar API capture

Observed request:

```text
https://chatgpt.com/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=5&limit=20&owned_only=false
```

The local [sample response](./sidebar.json) contains private project/account/chat
metadata. Do not copy its contents into public reports or synthetic fixtures.

The response has 7 named projects under `items[].gizmo.gizmo`, with display names
at `display.name`. The root `cursor` is null. Nested `conversations` contains
31 conversation previews and has its own cursor per project; 5 of those cursors
are non-null. These previews are not complete project conversation lists.

See the [Wave 4 plan](./local-sync-wave-4-plan.md), starting with project metadata,
for storage, pagination/account unknowns, viewer integration, and acceptance.
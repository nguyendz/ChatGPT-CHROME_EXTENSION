import { createHash } from 'node:crypto';

export function projectRaw(id = 'g-p-fixture-a', name = 'Research project', overrides = {}) {
  return {
    gizmo: {
      gizmo: {
        id, gizmo_type: 'snorlax', workspace_id: null,
        display: { name, description: 'Saved project description', emoji: null, theme: null },
        created_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-21T00:00:00Z',
        last_interacted_at: null, is_archived: false, instructions: 'Private synthetic instructions',
        ...overrides,
      },
      files: [], tools: [], product_features: { future_field: true },
    },
    conversations: { items: [], cursor: null },
  };
}

export function projectItem(raw) {
  return { raw, sha256: createHash('sha256').update(JSON.stringify(raw)).digest('hex') };
}

export function projectCaptureShape() {
  return {
    items: Array.from({ length: 7 }, (_, i) => {
      const raw = projectRaw(`g-p-synthetic-${i}`, `Synthetic project ${i}`);
      raw.conversations = {
        items: Array.from({ length: i === 4 ? 1 : 5 }, (_, j) => ({
          id: `preview-${i}-${j}`, title: `Synthetic title ${j}`,
          gizmo_id: raw.gizmo.gizmo.id, conversation_template_id: raw.gizmo.gizmo.id,
        })),
        cursor: [4, 6].includes(i) ? null : `nested-opaque-${i}`,
      };
      return raw;
    }),
    cursor: null,
  };
}

<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { Dialog } from 'quasar';
import { useWorkspace } from '../stores/workspace';
import { time, formatDuration } from '../render/domain';
import EventPicker from '../components/EventPicker.vue';
import ItemDetail from '../components/ItemDetail.vue';
const w = useWorkspace(),
  router = useRouter(),
  selected = ref(''),
  dragId = ref('');
const deleting = ref(false);
function removeSession() {
  const session = w.session;
  if (!session || !w.canEdit || deleting.value) return;
  Dialog.create({
    title: 'Delete session?',
    message: `Delete “${session.name}” and all its rundown items? This cannot be undone.`,
    cancel: true,
    persistent: true,
    ok: { label: 'Delete session', color: 'negative' },
  }).onOk(async () => {
    deleting.value = true;
    try {
      await w.removeSession(session.id);
    } catch (e) {
      w.fail(e);
    } finally {
      deleting.value = false;
    }
  });
}
const item = computed(() => w.orderedItems.find((i) => i.id === selected.value));
const runtime = computed(() => w.orderedItems.at(-1)?.endSec ?? 0);
const peopleCount = computed(() => new Set(w.items.flatMap((i) => i.personIds)).size);
const groups = computed(() => {
  const result: Record<string, typeof w.sessions> = {};
  for (const s of w.sessions) {
    const day = new Intl.DateTimeFormat('en-AU', {
      timeZone: w.event?.timeZone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }).format(s.startAt.toDate());
    (result[day] ??= []).push(s);
  }
  return result;
});
watch(
  () => w.sessionId,
  () => (selected.value = window.innerWidth >= 1050 ? 'item07' : ''),
);
async function add(categoryId?: string) {
  try {
    selected.value = await w.addItem(categoryId);
    setTimeout(() => document.querySelector<HTMLInputElement>('.item-title input')?.focus(), 100);
  } catch (e) {
    w.fail(e);
  }
}
async function duplicate() {
  if (item.value)
    try {
      selected.value = await w.addItem(item.value.categoryId, item.value);
    } catch (e) {
      w.fail(e);
    }
}
function key(e: KeyboardEvent) {
  if (deleting.value) return;
  if ((e.target as HTMLElement).closest('input,textarea,[contenteditable="true"],.q-dialog'))
    return;
  const at = w.orderedItems.findIndex((i) => i.id === selected.value);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    selected.value =
      w.orderedItems[
        Math.max(0, Math.min(w.items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))
      ]?.id ?? '';
  }
  if (e.key === 'Enter') document.querySelector<HTMLInputElement>('.item-title input')?.focus();
  if (!w.canEdit) return;
  if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
    e.preventDefault();
    void duplicate();
  }
  if (e.key === 'Delete' && selected.value) void w.removeItem(selected.value).catch(w.fail);
}
onMounted(() => window.addEventListener('keydown', key));
onUnmounted(() => window.removeEventListener('keydown', key));
function setLocal(value: string | null, part: 'date' | 'time') {
  if (!value) return;
  try {
    const current = w.sessionLocal().split('T');
    w.setSessionLocal(part === 'date' ? `${value}T${current[1]}` : `${current[0]}T${value}`);
  } catch (e) {
    w.fail(e);
  }
}
</script>
<template>
  <div class="workspace sessions-workspace" :class="{ 'detail-open': !!item }" :inert="deleting">
    <aside class="sidebar">
      <EventPicker />
      <div class="sidebar-heading eyebrow">Sessions</div>
      <section v-for="(list, day) in groups" :key="day" class="session-group">
        <h3>{{ day }}</h3>
        <button
          v-for="s in list"
          :key="s.id"
          class="session-link"
          :class="{ selected: w.sessionId === s.id }"
          @click="w.selectSession(s.id)"
        >
          <span>{{ s.name }}</span
          ><time>{{ time(s.startAt.toDate().toISOString(), 0, w.event?.timeZone, true) }}</time>
        </button>
      </section>
      <q-btn
        v-if="w.event"
        outline
        no-caps
        icon="add"
        label="New session"
        color="primary"
        class="new-button"
        :disable="!w.canEdit"
        @click="w.addSession().catch(w.fail)"
      />
    </aside>
    <main class="workspace-main">
      <template v-if="w.session"
        ><section class="card session-card">
          <div class="section-heading">
            <h1>Session</h1>
            <div class="button-row">
              <q-btn
                flat
                no-caps
                color="negative"
                label="Delete"
                aria-label="Delete session"
                :disable="!w.canEdit"
                :loading="deleting"
                @click="removeSession"
              />
              <q-btn
                outline
                no-caps
                label="Duplicate"
                :disable="!w.canEdit"
                @click="w.addSession(true).catch(w.fail)"
              /><q-btn
                color="primary"
                no-caps
                icon="print"
                label="Print packs"
                @click="router.push('/export')"
              />
            </div>
          </div>
          <fieldset :disabled="!w.canEdit || deleting" class="session-fields">
            <label
              >Session name<q-input
                :model-value="w.session.name"
                outlined
                dense
                @update:model-value="(v) => v && w.patchSession({ name: String(v) })" /></label
            ><label
              >Event<q-select
                :model-value="w.eventId"
                :options="w.events"
                option-label="name"
                option-value="id"
                emit-value
                map-options
                outlined
                dense
                @update:model-value="(v) => w.moveSession(v).catch(w.fail)"
            /></label>
            <div class="two-fields">
              <label
                >Date<q-input
                  :model-value="w.sessionLocal().split('T')[0]"
                  outlined
                  dense
                  type="date"
                  @update:model-value="(v) => setLocal(String(v), 'date')" /></label
              ><label
                >Start time<q-input
                  :model-value="w.sessionLocal().split('T')[1]"
                  outlined
                  dense
                  type="time"
                  @update:model-value="(v) => setLocal(String(v), 'time')"
              /></label>
            </div>
            <label
              >Subtitle<q-input
                :model-value="w.session.subtitle || ''"
                outlined
                dense
                @update:model-value="(v) => w.patchSession({ subtitle: String(v ?? '') })"
            /></label>
          </fieldset>
          <div class="summary-strip">
            <span
              ><strong>{{ w.items.length }}</strong> items</span
            ><span
              >Runtime <b class="mono">{{ formatDuration(runtime) }}</b></span
            ><span
              >Ends
              <b class="mono">{{
                time(w.session.startAt.toDate().toISOString(), runtime, w.event?.timeZone, true)
              }}</b></span
            ><span
              ><strong>{{ peopleCount }}</strong> people</span
            >
          </div>
        </section>
        <section class="card rundown-card">
          <div class="table-scroll">
            <table class="rundown-table">
              <thead>
                <tr>
                  <th aria-label="Reorder"></th>
                  <th>#</th>
                  <th>Start</th>
                  <th>Dur</th>
                  <th>Item</th>
                  <th>Category</th>
                  <th>People</th>
                  <th>Attached</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in w.orderedItems"
                  :key="row.id"
                  :class="{ selected: selected === row.id }"
                  tabindex="0"
                  :aria-selected="selected === row.id"
                  @click="selected = row.id"
                  @keydown.enter="selected = row.id"
                  @dragover.prevent
                  @drop.prevent="w.reorderItem(dragId, row.id)"
                >
                  <td>
                    <span
                      class="drag-handle"
                      :draggable="w.canEdit"
                      @dragstart="dragId = row.id"
                      title="Drag to reorder"
                      >⠿</span
                    >
                  </td>
                  <td class="muted">{{ row.number }}</td>
                  <td class="mono">
                    {{
                      time(
                        w.session.startAt.toDate().toISOString(),
                        row.startSec,
                        w.event?.timeZone,
                      )
                    }}
                  </td>
                  <td class="mono muted">{{ formatDuration(row.durationSec) }}</td>
                  <td class="item-cell" :title="row.title">{{ row.title }}</td>
                  <td>
                    <span
                      class="pill"
                      :style="{ background: row.category.bg, color: row.category.fg }"
                      >{{ row.category.name }}</span
                    >
                  </td>
                  <td class="people-cell" :title="row.people.map((p) => p.name).join(', ')">
                    {{ row.people.map((p) => p.name).join(', ') || '—' }}
                  </td>
                  <td class="attachments">
                    <span v-if="row.notes">Notes</span><span v-if="row.script">Script</span
                    ><span v-if="Object.values(row.av).some(Boolean)">AV</span
                    ><span v-if="row.imageSlide">Slide</span>
                  </td>
                </tr>
                <tr v-if="!w.items.length">
                  <td colspan="8" class="empty-state">
                    Add the first item to start your running order.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <footer
            class="table-footer"
            @dragover.prevent
            @drop.prevent="w.reorderItem(dragId, null)"
          >
            <q-btn
              outline
              no-caps
              color="primary"
              icon="add"
              label="Add item"
              :disable="!w.canEdit || !w.categories.length"
              @click="add()"
            /><span class="muted">Quick add:</span
            ><button
              v-for="cat in w.categories.filter((c) => !c.archived)"
              :key="cat.id"
              class="pill quick-add"
              :style="{ background: cat.bg, color: cat.fg }"
              :disabled="!w.canEdit"
              @click="add(cat.id)"
            >
              {{ cat.name }}
            </button>
          </footer>
        </section>
        <p class="keyboard-hint">
          ↑ ↓ Select item <span>Enter Edit</span><span>⌘ / Ctrl D Duplicate</span
          ><span>Delete Remove with undo</span>
        </p></template
      >
      <div v-else class="empty-state">
        <h1>{{ w.event ? 'Plan your first session' : 'Start with an event' }}</h1>
        <p>
          {{
            w.event
              ? 'Add a session using the sidebar.'
              : 'Create an event to begin its running order.'
          }}
        </p>
      </div>
    </main>
    <ItemDetail
      v-if="item"
      :key="item.id"
      :item="item"
      @close="selected = ''"
      @duplicate="duplicate"
    />
  </div>
</template>

import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { User } from 'firebase/auth';
import {
  collection,
  doc,
  onSnapshot,
  getDocs,
  getDocsFromServer,
  getDoc,
  writeBatch,
  setDoc,
  updateDoc,
  deleteDoc,
  Timestamp,
  query,
  orderBy,
  increment,
  arrayUnion,
  type Unsubscribe,
} from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { httpsCallable } from 'firebase/functions';
import { Notify } from 'quasar';
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { Temporal } from '@js-temporal/polyfill';
import { db, storage, auth, emulator, functions } from '../boot/firebase';
import type {
  Tenant,
  Event,
  Session,
  Item,
  Person,
  Category,
  Template,
  Role,
  StoredImage,
} from '../types';
import { defaultPack } from '../types';
import { computeItems } from '../render/domain';
import seed from '../../../reference/seed.json';
export const useWorkspace = defineStore('workspace', () => {
  const user = ref<User | null>(null),
    ready = ref(false),
    error = ref(''),
    status = ref('Connecting…');
  const tenantId = ref(''),
    eventId = ref(''),
    sessionId = ref(''),
    role = ref<Role>('viewer');
  const tenants = ref<Tenant[]>([]),
    events = ref<Event[]>([]),
    sessions = ref<Session[]>([]),
    items = ref<Item[]>([]),
    people = ref<Person[]>([]),
    categories = ref<Category[]>([]),
    templates = ref<Template[]>([]);
  const tenant = computed(() => tenants.value.find((t) => t.id === tenantId.value));
  const event = computed(() => events.value.find((e) => e.id === eventId.value));
  const session = computed(() => sessions.value.find((s) => s.id === sessionId.value));
  const orderedItems = computed(() => computeItems(items.value, categories.value, people.value));
  const canEdit = computed(() => role.value === 'owner' || role.value === 'editor');
  let userStop: Unsubscribe | undefined,
    tenantStops: Unsubscribe[] = [],
    eventStops: Unsubscribe[] = [],
    sessionStop: Unsubscribe | undefined;
  const pending = new Map<
    string,
    { patch: Record<string, unknown>; timer: ReturnType<typeof setTimeout> | null }
  >();
  const saving = ref(0);
  function fail(e: unknown) {
    console.error(e);
    const code = (e as { code?: string })?.code;
    error.value =
      code === 'permission-denied'
        ? 'You do not have permission to make this change.'
        : e instanceof Error
          ? e.message
          : String(e);
    status.value = 'Save failed';
    Notify.create({ type: 'negative', message: error.value, timeout: 7000 });
  }
  function base() {
    if (!tenantId.value) throw new Error('Select an organisation.');
    return `tenants/${tenantId.value}`;
  }
  function eventPath() {
    if (!eventId.value) throw new Error('Select an event.');
    return `${base()}/events/${eventId.value}`;
  }
  function itemPath() {
    if (!sessionId.value) throw new Error('Select a session.');
    return `${eventPath()}/sessions/${sessionId.value}/items`;
  }
  function listen<T>(path: string, target: { value: T[] }, sort?: string, after?: () => void) {
    const col = collection(db, path);
    return onSnapshot(
      sort ? query(col, orderBy(sort)) : col,
      { includeMetadataChanges: true },
      (snapshot) => {
        target.value = snapshot.docs.map(
          (d) => ({ id: d.id, ...d.data(), ...pending.get(d.ref.path)?.patch }) as T,
        );
        if (!pending.size && !saving.value)
          status.value = snapshot.metadata.hasPendingWrites
            ? 'Saving…'
            : snapshot.metadata.fromCache
              ? 'Offline · cached'
              : 'Saved · just now';
        after?.();
      },
      fail,
    );
  }
  async function setUser(u: User | null) {
    user.value = u;
    userStop?.();
    tenantStops.forEach((f) => f());
    eventStops.forEach((f) => f());
    sessionStop?.();
    tenants.value = [];
    events.value = [];
    sessions.value = [];
    items.value = [];
    people.value = [];
    categories.value = [];
    templates.value = [];
    tenantId.value = '';
    eventId.value = '';
    sessionId.value = '';
    ready.value = true;
    if (!u) return;
    userStop = onSnapshot(
      doc(db, 'users', u.uid),
      { includeMetadataChanges: true },
      async (snap) => {
        if (snap.metadata.hasPendingWrites) return;
        try {
          const ids = (snap.data()?.tenantIds ?? []) as string[];
          const docs = await Promise.all(ids.map((id) => getDoc(doc(db, 'tenants', id))));
          tenants.value = docs
            .filter((d) => d.exists())
            .map((d) => ({ id: d.id, ...d.data() }) as Tenant);
          if (tenants.value.length && !tenantId.value) await selectTenant(tenants.value[0].id);
        } catch (e) {
          fail(e);
        }
      },
      fail,
    );
  }
  async function createTenant(name: string, sample = false) {
    if (!user.value || !name.trim()) return;
    const t = doc(collection(db, 'tenants')),
      now = Timestamp.now();
    let b = writeBatch(db);
    b.set(t, { name: name.trim(), createdAt: now, createdBy: user.value.uid });
    b.set(doc(t, 'members', user.value.uid), {
      role: 'owner',
      displayName: user.value.displayName || 'Producer',
      email: user.value.email || '',
      addedAt: now,
    });
    b.set(
      doc(db, 'users', user.value.uid),
      { tenantIds: arrayUnion(t.id), lastTenantId: t.id },
      { merge: true },
    );
    await b.commit();
    b = writeBatch(db);
    if (sample) {
      for (const c of seed.categories) {
        const { id, ...data } = c;
        b.set(doc(t, 'categories', id), data);
      }
      for (const template of seed.templates) {
        const { id, ...data } = template;
        b.set(doc(t, 'templates', id), data);
      }
      const { id: eventKey, ...eventData } = seed.event;
      b.set(doc(t, 'events', eventKey), eventData);
      for (const person of seed.people) {
        const { id, ...data } = person;
        b.set(doc(t, 'events', eventKey, 'people', id), data);
      }
      for (const sess of seed.sessions) {
        const { id, items: rows, startAt, ...data } = sess;
        const stamp = Timestamp.fromDate(new Date(startAt));
        b.set(doc(t, 'events', eventKey, 'sessions', id), {
          ...data,
          startAt: stamp,
          sortKey: stamp,
          itemCount: rows.length,
        });
        for (const row of rows) {
          const { id: itemId, ...item } = row;
          b.set(doc(t, 'events', eventKey, 'sessions', id, 'items', itemId), {
            ...item,
            updatedAt: now,
            updatedBy: user.value.uid,
          });
        }
      }
    } else {
      for (const c of seed.categories) {
        const { id, ...data } = c;
        b.set(doc(t, 'categories', id), data);
      }
      for (const template of seed.templates) {
        const { id, ...data } = template;
        b.set(doc(t, 'templates', id), data);
      }
    }
    await b.commit();
    await selectTenant(t.id);
  }
  async function selectTenant(id: string) {
    tenantStops.forEach((f) => f());
    eventStops.forEach((f) => f());
    sessionStop?.();
    role.value = 'viewer';
    tenantId.value = id;
    eventId.value = '';
    sessionId.value = '';
    events.value = [];
    sessions.value = [];
    items.value = [];
    people.value = [];
    categories.value = [];
    templates.value = [];
    const m = await getDoc(doc(db, `tenants/${id}/members/${user.value!.uid}`));
    role.value = m.data()?.role ?? 'viewer';
    tenantStops = [
      onSnapshot(
        doc(db, `tenants/${id}`),
        (snapshot) => {
          if (!snapshot.exists()) return;
          const index = tenants.value.findIndex((t) => t.id === id);
          const value = { id, ...snapshot.data() } as Tenant;
          if (index < 0) tenants.value.push(value);
          else tenants.value[index] = value;
        },
        fail,
      ),
      listen(`${base()}/categories`, categories, 'order'),
      listen(`${base()}/templates`, templates),
      listen(`${base()}/events`, events, 'startDate', () => {
        if (!eventId.value && events.value[0]) selectEvent(events.value[0].id);
      }),
    ];
  }
  function selectEvent(id: string) {
    eventStops.forEach((f) => f());
    sessionStop?.();
    eventId.value = id;
    sessionId.value = '';
    sessions.value = [];
    items.value = [];
    people.value = [];
    eventStops = [
      listen(`${eventPath()}/people`, people),
      listen(`${eventPath()}/sessions`, sessions, 'sortKey', () => {
        if (!sessionId.value && sessions.value.length)
          selectSession(
            sessions.value.find((s) => s.id === 'sat-evening')?.id ?? sessions.value[0].id,
          );
      }),
    ];
  }
  function selectSession(id: string) {
    sessionStop?.();
    sessionId.value = id;
    items.value = [];
    sessionStop = id ? listen(itemPath(), items, 'order') : undefined;
  }
  function edit(path: string, patch: Record<string, unknown>) {
    if (!canEdit.value) return;
    const old = pending.get(path);
    if (old?.timer) clearTimeout(old.timer);
    const value = {
      patch: { ...old?.patch, ...patch },
      timer: null as ReturnType<typeof setTimeout> | null,
    };
    pending.set(path, value);
    status.value = 'Unsaved changes';
    value.timer = setTimeout(() => void flushOne(path), 600);
  }
  async function flushOne(path: string) {
    const p = pending.get(path);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    pending.delete(path);
    saving.value++;
    status.value = 'Saving…';
    try {
      await updateDoc(doc(db, path), p.patch);
    } catch (e) {
      const newer = pending.get(path);
      pending.set(path, { patch: { ...p.patch, ...newer?.patch }, timer: newer?.timer ?? null });
      fail(e);
    } finally {
      saving.value--;
      if (!pending.size && !saving.value) status.value = 'Saved · just now';
    }
  }
  async function flush() {
    await Promise.all([...pending.keys()].map(flushOne));
    if (pending.size) throw new Error('Changes could not be saved. Retry before exporting.');
  }
  function patchItem(id: string, patch: Partial<Item>) {
    const row = items.value.find((i) => i.id === id);
    if (row) Object.assign(row, patch);
    edit(`${itemPath()}/${id}`, {
      ...patch,
      updatedAt: Timestamp.now(),
      updatedBy: user.value!.uid,
    });
  }
  function patchSession(patch: Partial<Session>) {
    if (session.value) Object.assign(session.value, patch);
    edit(`${eventPath()}/sessions/${sessionId.value}`, { ...patch });
  }
  function patchTemplate(id: string, patch: Partial<Template>) {
    const t = templates.value.find((t) => t.id === id);
    if (t) Object.assign(t, patch);
    edit(`${base()}/templates/${id}`, { ...patch, updatedAt: Timestamp.now() });
  }
  function patchPerson(id: string, patch: Partial<Person>) {
    const p = people.value.find((p) => p.id === id);
    if (p) Object.assign(p, patch);
    edit(`${eventPath()}/people/${id}`, patch);
  }
  function duplicatePack(sourceId: string, targetId: string) {
    if (!canEdit.value) throw new Error('Editor access required.');
    const source = people.value.find((p) => p.id === sourceId);
    const target = people.value.find((p) => p.id === targetId);
    if (!source || !target || sourceId === targetId)
      throw new Error('Choose another person in this event.');
    patchPerson(targetId, { pack: JSON.parse(JSON.stringify(source.pack)) });
  }
  function patchCategory(id: string, patch: Partial<Category>) {
    const c = categories.value.find((c) => c.id === id);
    if (c) Object.assign(c, patch);
    edit(`${base()}/categories/${id}`, patch);
  }
  async function addItem(
    categoryId = categories.value.find((c) => !c.archived)?.id,
    source?: Item,
  ) {
    if (!categoryId) throw new Error('Add a category first.');
    const ref = doc(collection(db, itemPath()));
    const data = {
      title: 'New item',
      durationSec: 300,
      categoryId,
      personIds: [],
      av: {},
      ...(source
        ? {
            title: source.title,
            durationSec: source.durationSec,
            categoryId: source.categoryId,
            personIds: source.personIds,
            notes: source.notes ?? '',
            script: source.script ?? '',
            av: source.av,
            imageSlide: source.imageSlide ?? null,
          }
        : {}),
      order: generateKeyBetween(orderedItems.value.at(-1)?.order ?? null, null),
      updatedAt: Timestamp.now(),
      updatedBy: user.value!.uid,
    };
    const { id: unused, ...clean } = data as Item;
    void unused;
    const b = writeBatch(db);
    b.set(ref, clean);
    b.update(doc(db, `${eventPath()}/sessions/${sessionId.value}`), { itemCount: increment(1) });
    await b.commit();
    return ref.id;
  }
  async function removeItem(id: string) {
    await flush();
    const item = items.value.find((i) => i.id === id);
    if (!item) return;
    const path = itemPath(),
      sess = `${eventPath()}/sessions/${sessionId.value}`;
    const b = writeBatch(db);
    b.delete(doc(db, path, id));
    b.update(doc(db, sess), { itemCount: increment(-1) });
    await b.commit();
    Notify.create({
      message: 'Item deleted',
      timeout: 6000,
      actions: [
        {
          label: 'Undo',
          color: 'white',
          handler: () => {
            const restore = writeBatch(db);
            const { id, ...data } = item;
            restore.set(doc(db, path, id), {
              ...data,
              updatedBy: user.value!.uid,
              updatedAt: Timestamp.now(),
            });
            restore.update(doc(db, sess), { itemCount: increment(1) });
            void restore.commit().catch(fail);
          },
        },
      ],
    });
  }
  function reorderItem(id: string, beforeId: string | null) {
    const rows = orderedItems.value.filter((i) => i.id !== id),
      at = beforeId ? rows.findIndex((i) => i.id === beforeId) : rows.length;
    if (at < 0) return;
    patchItem(id, {
      order: generateKeyBetween(rows[at - 1]?.order ?? null, rows[at]?.order ?? null),
    });
  }
  async function addSession(copy = false) {
    await flush();
    const ref = doc(collection(db, `${eventPath()}/sessions`)),
      stamp = copy && session.value ? session.value.startAt : Timestamp.now(),
      b = writeBatch(db);
    b.set(ref, {
      name: copy ? `${session.value?.name} (copy)` : 'New session',
      subtitle: copy ? (session.value?.subtitle ?? '') : '',
      startAt: stamp,
      sortKey: stamp,
      itemCount: copy ? items.value.length : 0,
    });
    if (copy)
      for (const item of items.value) {
        const { id, ...data } = item;
        b.set(doc(collection(ref, 'items')), {
          ...data,
          updatedBy: user.value!.uid,
          updatedAt: Timestamp.now(),
        });
      }
    await b.commit();
    selectSession(ref.id);
  }
  async function moveSession(destinationId: string) {
    if (destinationId === eventId.value || !session.value) return;
    await flush();
    const origin = doc(db, `${eventPath()}/sessions/${sessionId.value}`),
      target = doc(collection(db, `${base()}/events/${destinationId}/sessions`));
    const destinationPeople = await getDocs(
      collection(db, `${base()}/events/${destinationId}/people`),
    );
    const assigned = new Set(items.value.flatMap((i) => i.personIds));
    if (items.value.length * 2 + assigned.size + 2 > 450)
      throw new Error('This session is too large to move in a single safe operation.');
    const b = writeBatch(db),
      personIds = new Map<string, string>();
    for (const id of assigned) {
      const person = people.value.find((p) => p.id === id);
      if (!person) continue;
      const existing = destinationPeople.docs.find(
        (d) =>
          (person.email && d.data().email === person.email) ||
          (d.data().name === person.name && d.data().role === person.role),
      );
      if (existing) personIds.set(id, existing.id);
      else {
        const ref = doc(collection(db, `${base()}/events/${destinationId}/people`));
        const { id: unused, ...data } = person;
        void unused;
        b.set(ref, data);
        personIds.set(id, ref.id);
      }
    }
    const { id: unused, ...data } = session.value;
    void unused;
    b.set(target, data);
    for (const item of items.value) {
      const { id, ...row } = item;
      b.set(doc(target, 'items', id), {
        ...row,
        personIds: row.personIds.map((p) => personIds.get(p)).filter(Boolean),
        updatedBy: user.value!.uid,
        updatedAt: Timestamp.now(),
      });
      b.delete(doc(origin, 'items', id));
    }
    b.delete(origin);
    await b.commit();
    selectEvent(destinationId);
    selectSession(target.id);
  }
  async function removeSession(id: string) {
    if (!canEdit.value) throw new Error('Editor access required.');
    const scope = { tenantId: tenantId.value, eventId: eventId.value, sessionId: id };
    const target = doc(db, `${eventPath()}/sessions/${id}`);
    await flush();
    const rows = await getDocsFromServer(collection(target, 'items'));
    if (rows.size >= 500) {
      await httpsCallable(functions, 'deleteSession')(scope);
    } else {
      const batch = writeBatch(db);
      rows.docs.forEach((row) => batch.delete(row.ref));
      batch.delete(target);
      await batch.commit();
    }
    if (tenantId.value === scope.tenantId && eventId.value === scope.eventId) {
      sessions.value = sessions.value.filter((s) => s.id !== id);
      if (sessionId.value === id) selectSession(sessions.value[0]?.id ?? '');
    }
    Notify.create({ type: 'positive', message: 'Session deleted' });
  }
  async function addEvent(data: Omit<Event, 'id'>) {
    const ref = doc(collection(db, `${base()}/events`));
    await setDoc(ref, data);
    selectEvent(ref.id);
  }
  async function saveEvent(data: Partial<Event>) {
    await updateDoc(doc(db, eventPath()), data);
  }
  async function addPerson(name: string, role = '', email = '') {
    const ref = doc(collection(db, `${eventPath()}/people`));
    await setDoc(ref, { name: name.trim(), role, ...(email && { email }), pack: defaultPack() });
    return ref.id;
  }
  async function removePerson(id: string, removeAssignments = false) {
    await flush();
    const allSessions = await getDocs(collection(db, `${eventPath()}/sessions`));
    const allItems = await Promise.all(
      allSessions.docs.map((s) => getDocs(collection(s.ref, 'items'))),
    );
    const assigned = allItems.flatMap((s) => s.docs).filter((i) => i.data().personIds.includes(id));
    if (assigned.length && !removeAssignments)
      throw new Error('This person is assigned to items. Choose “Remove from items and delete”.');
    if (assigned.length > 450)
      throw new Error(
        'Too many assignments to remove safely in one operation. Remove assignments first.',
      );
    const b = writeBatch(db);
    for (const i of assigned)
      b.update(i.ref, {
        personIds: i.data().personIds.filter((v: string) => v !== id),
        updatedBy: user.value!.uid,
        updatedAt: Timestamp.now(),
      });
    b.delete(doc(db, `${eventPath()}/people/${id}`));
    await b.commit();
  }
  async function addCategory(name: string, bg = '#EEF0F3', fg = '#4A5160') {
    await setDoc(doc(collection(db, `${base()}/categories`)), {
      name,
      bg,
      fg,
      order: categories.value.length,
    });
  }
  async function removeCategory(id: string) {
    const allEvents = await getDocs(collection(db, `${base()}/events`));
    for (const ev of allEvents.docs) {
      const ss = await getDocs(collection(ev.ref, 'sessions'));
      for (const s of ss.docs) {
        const rows = await getDocs(collection(s.ref, 'items'));
        if (rows.docs.some((i) => i.data().categoryId === id))
          throw new Error('Category is in use. Archive it instead.');
      }
    }
    await deleteDoc(doc(db, `${base()}/categories/${id}`));
  }
  async function addTemplate(source?: Template) {
    const ref = doc(collection(db, `${base()}/templates`));
    const { id, ...data } = source ?? (seed.templates[0] as Template);
    await setDoc(ref, {
      ...data,
      archived: false,
      name: source ? `${source.name} (copy)` : 'New template',
    });
    return ref.id;
  }
  async function removeTemplate(id: string): Promise<boolean> {
    if (!canEdit.value) throw new Error('Editor access required.');
    const root = base();
    await flush();
    const allEvents = await getDocsFromServer(collection(db, `${root}/events`));
    for (const event of allEvents.docs) {
      const people = await getDocsFromServer(collection(event.ref, 'people'));
      if (
        people.docs.some((p) =>
          (p.data() as Person).pack.templates.some((t) => t.templateId === id),
        )
      )
        return false;
    }
    await deleteDoc(doc(db, `${root}/templates/${id}`));
    if (`tenants/${tenantId.value}` === root)
      templates.value = templates.value.filter((t) => t.id !== id);
    Notify.create({ type: 'positive', message: 'Template deleted' });
    return true;
  }
  async function uploadImage(file: File, path: string): Promise<StoredImage> {
    if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 10 * 1024 * 1024)
      throw new Error('Choose a PNG or JPG image up to 10 MB.');
    const bitmap = await createImageBitmap(file);
    const destination = storageRef(
      storage,
      `${path}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`,
    );
    await uploadBytes(destination, file, { contentType: file.type });
    const url = await getDownloadURL(destination);
    const image = {
      path: destination.fullPath,
      name: file.name,
      width: bitmap.width,
      height: bitmap.height,
      contentType: file.type,
      url,
    };
    bitmap.close();
    return image;
  }
  async function saveSlide(path: string, id: string, image: StoredImage) {
    await updateDoc(doc(db, path, id), {
      imageSlide: image,
      updatedAt: Timestamp.now(),
      updatedBy: user.value!.uid,
    });
  }
  async function uploadOrganisationLogo(file: File) {
    if (role.value !== 'owner')
      throw new Error('Owner access required to change the organisation logo.');
    const path = base();
    const id = tenantId.value;
    const logo = await uploadImage(file, `${path}/logo`);
    await updateDoc(doc(db, path), { logo });
    const organisation = tenants.value.find((t) => t.id === id);
    if (organisation) organisation.logo = logo;
  }
  function sessionLocal() {
    if (!session.value || !event.value) return '';
    return Temporal.Instant.fromEpochMilliseconds(session.value.startAt.toMillis())
      .toZonedDateTimeISO(event.value.timeZone)
      .toPlainDateTime()
      .toString()
      .slice(0, 16);
  }
  function setSessionLocal(local: string) {
    if (!event.value) return;
    const stamp = Timestamp.fromMillis(
      Number(
        Temporal.PlainDateTime.from(local).toZonedDateTime(event.value.timeZone, {
          disambiguation: 'reject',
        }).epochMilliseconds,
      ),
    );
    patchSession({ startAt: stamp, sortKey: stamp });
  }
  window.addEventListener('beforeunload', (e) => {
    if (pending.size || saving.value) {
      e.preventDefault();
    }
  });
  return {
    user,
    ready,
    error,
    status,
    tenantId,
    eventId,
    sessionId,
    role,
    tenants,
    events,
    sessions,
    items,
    people,
    categories,
    templates,
    tenant,
    event,
    session,
    orderedItems,
    canEdit,
    setUser,
    createTenant,
    selectTenant,
    selectEvent,
    selectSession,
    fail,
    flush,
    patchItem,
    patchSession,
    patchTemplate,
    patchPerson,
    duplicatePack,
    patchCategory,
    addItem,
    removeItem,
    reorderItem,
    addSession,
    removeSession,
    moveSession,
    addEvent,
    saveEvent,
    addPerson,
    removePerson,
    addCategory,
    removeCategory,
    addTemplate,
    removeTemplate,
    uploadImage,
    uploadOrganisationLogo,
    saveSlide,
    itemPath,
    eventPath,
    base,
    sessionLocal,
    setSessionLocal,
    emulator,
  };
});

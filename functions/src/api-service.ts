import {
  FieldPath,
  FieldValue,
  Timestamp,
  type Firestore,
  type Transaction,
  type DocumentReference,
  type DocumentData,
  type DocumentSnapshot,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import type { Auth, DecodedIdToken } from 'firebase-admin/auth';
import { getStorage, getDownloadURL } from 'firebase-admin/storage';
import { HttpsError } from 'firebase-functions/v2/https';
import { generateKeyBetween } from 'fractional-indexing';
import { operations, recordSchemas, type Resource } from './api-contract';
import { defaultPack, type Item, type Category, type Person } from '../../app/src/types';
import { computeItems } from '../../app/src/render/domain';

export function fail(code: ConstructorParameters<typeof HttpsError>[0], message: string): never {
  throw new HttpsError(code, message);
}
export function serialize(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serialize(v)]));
  return value;
}
function record(doc: DocumentSnapshot): DocumentData {
  if (!doc.exists) fail('not-found', 'Record not found.');
  return { ...doc.data(), id: doc.id };
}
export function checkRole(role: unknown, access: string) {
  if (!['owner', 'editor', 'viewer'].includes(String(role)))
    fail('permission-denied', 'Organisation membership required.');
  if (access === 'owner' && role !== 'owner') fail('permission-denied', 'Owner access required.');
  if (access === 'edit' && !['owner', 'editor'].includes(String(role)))
    fail('permission-denied', 'Editor access required.');
}
export async function authorize(db: Firestore, uid: string, tenantId: string, access: string) {
  checkRole((await db.doc(`tenants/${tenantId}/members/${uid}`).get()).data()?.role, access);
}
export function validateImagePath(path: string, tenantId: string) {
  const escaped = tenantId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (
    !new RegExp(
      `^tenants/${escaped}/(?:logo/[^/]+|events/[A-Za-z0-9_-]+/(?:logo/[^/]+|sessions/[A-Za-z0-9_-]+/items/[A-Za-z0-9_-]+/[^/]+))$`,
    ).test(path) ||
    path.split('/').some((s) => s === '.' || s === '..')
  )
    fail('invalid-argument', 'Image path must be a logo or item image within this organisation.');
}

export class RundownService {
  constructor(
    private db: Firestore,
    private auth: Auth,
  ) {}

  async execute(operation: string, input: unknown, user: DecodedIdToken) {
    const op = operations[operation];
    if (!Object.hasOwn(operations, operation)) fail('not-found', 'Unknown operation.');
    const a = op.schema.parse(input) as DocumentData;
    if (operation === 'auth_revoke') {
      if (Date.now() / 1000 - user.auth_time > 300)
        fail('failed-precondition', 'Sign in again before revoking sessions.');
      await this.auth.revokeRefreshTokens(user.uid);
      return { revoked: true };
    }
    const result = await this.db.runTransaction(async (tx) => {
      const db = this.db,
        uid = user.uid;
      const tenantId = op.resource === 'tenants' ? a.id : a.tenantId;
      const root = tenantId ? db.doc(`tenants/${tenantId}`) : undefined;
      const writes: (() => void)[] = [];
      const set = (ref: DocumentReference, data: DocumentData) =>
        writes.push(() => tx.set(ref, data));
      const patch = (ref: DocumentReference, data: DocumentData) =>
        writes.push(() => tx.update(ref, data));
      const remove = (ref: DocumentReference) => writes.push(() => tx.delete(ref));
      const read = async (ref: DocumentReference) => record(await tx.get(ref));
      const all = async (q: Query): Promise<QueryDocumentSnapshot[]> => {
        const snap = await tx.get(q.limit(451));
        if (snap.size > 450)
          fail(
            'resource-exhausted',
            'Operation exceeds 450 records. Split the work into smaller operations.',
          );
        return snap.docs;
      };
      const page = async (q: Query) => {
        q = q.orderBy(FieldPath.documentId());
        if (a.after) q = q.startAfter(a.after);
        const docs = (await tx.get(q.limit((a.limit ?? 100) + 1))).docs;
        const selected = docs.slice(0, a.limit ?? 100);
        return {
          records: selected.map(record),
          nextCursor: docs.length > selected.length ? selected.at(-1)!.id : null,
        };
      };
      if (op.access !== 'signedIn') {
        checkRole((await tx.get(root!.collection('members').doc(uid))).data()?.role, op.access);
        await read(root!);
      }
      const event = root && a.eventId ? root.collection('events').doc(a.eventId) : undefined;
      const session =
        event && a.sessionId ? event.collection('sessions').doc(a.sessionId) : undefined;
      if (event) await read(event);
      if (session) await read(session);
      const now = Timestamp.now();
      const stamp = { updatedAt: now, updatedBy: uid };
      const validateReferences = async (
        resource: Resource,
        data: DocumentData,
        previous?: DocumentData,
      ) => {
        const images = [data.logo, data.imageSlide].filter(Boolean);
        for (const image of images) {
          // The handover uses seed placeholders; preserve existing ones, but do not accept new paths.
          if (
            image.path.startsWith('seed/') &&
            [previous?.logo?.path, previous?.imageSlide?.path].includes(image.path)
          )
            continue;
          validateImagePath(image.path, tenantId);
          if (image !== previous?.logo && image !== previous?.imageSlide) {
            const file = getStorage().bucket().file(image.path);
            if (!(await file.exists())[0])
              fail('not-found', 'Image file does not exist. Upload it first.');
            // The preview consumes the same Firebase download URL as browser uploads.
            image.url = await getDownloadURL(file);
          }
        }
        if (resource === 'events') {
          if (data.endDate < data.startDate)
            fail('invalid-argument', 'endDate precedes startDate.');
          try {
            new Intl.DateTimeFormat('en', { timeZone: data.timeZone });
          } catch {
            fail('invalid-argument', 'Invalid IANA timeZone.');
          }
        }
        if (resource === 'items') {
          await read(root!.collection('categories').doc(data.categoryId));
          for (const personId of data.personIds ?? [])
            await read(event!.collection('people').doc(personId));
        }
        if (resource === 'people')
          for (const ref of data.pack?.templates ?? [])
            await read(root!.collection('templates').doc(ref.templateId));
        if (resource === 'templates')
          for (const categoryId of data.filter.categoryIds ?? [])
            await read(root!.collection('categories').doc(categoryId));
      };
      const eventItems = async (eventRef: DocumentReference, filter?: (q: Query) => Query) => {
        const items: QueryDocumentSnapshot[] = [];
        for (const s of await all(eventRef.collection('sessions'))) {
          items.push(
            ...(await all(filter ? filter(s.ref.collection('items')) : s.ref.collection('items'))),
          );
          if (items.length > 450)
            fail(
              'resource-exhausted',
              'Too many affected items. Remove assignments in smaller operations.',
            );
        }
        return items;
      };
      let output: unknown;
      if (op.resource === 'tenants' && op.action === 'list') {
        const ids: string[] = (await tx.get(db.doc(`users/${uid}`))).data()?.tenantIds ?? [];
        const sorted = [...new Set(ids)].filter((v) => !a.after || v > a.after).sort();
        const rows: DocumentData[] = [];
        for (const key of sorted) {
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) continue;
          const ref = db.doc(`tenants/${key}`);
          const membership = await tx.get(ref.collection('members').doc(uid));
          if (!['owner', 'editor', 'viewer'].includes(membership.data()?.role)) continue;
          const doc = await tx.get(ref);
          if (doc.exists) rows.push({ ...record(doc), role: membership.data()!.role });
          if (rows.length > (a.limit ?? 100)) break;
        }
        const selected = rows.slice(0, a.limit ?? 100);
        output = {
          records: selected,
          nextCursor: rows.length > selected.length ? selected.at(-1)!.id : null,
        };
      } else if (op.resource === 'tenants' && op.action === 'create') {
        if (a.data.logo)
          fail('invalid-argument', 'Upload the logo after creating the organisation.');
        const profile = db.doc(`users/${uid}`);
        if (((await tx.get(profile)).data()?.tenantIds ?? []).length >= 100)
          fail('resource-exhausted', 'Maximum 100 organisations per user.');
        const ref = db.collection('tenants').doc();
        set(ref, { name: a.data.name, createdAt: now, createdBy: uid });
        set(ref.collection('members').doc(uid), {
          role: 'owner',
          displayName: user.name ?? '',
          email: user.email ?? '',
          addedAt: now,
        });
        writes.push(() =>
          tx.set(
            profile,
            { tenantIds: FieldValue.arrayUnion(ref.id), lastTenantId: ref.id },
            { merge: true },
          ),
        );
        output = { id: ref.id, ...a.data };
      } else if (op.resource) {
        const resource = op.resource;
        const collection =
          resource === 'tenants'
            ? db.collection('tenants')
            : resource === 'items'
              ? session!.collection('items')
              : ['people', 'sessions'].includes(resource)
                ? event!.collection(resource)
                : root!.collection(resource);
        if (op.action === 'list') output = await page(collection);
        else {
          const ref = op.action === 'create' ? collection.doc() : collection.doc(a.id);
          const previous = op.action === 'create' ? undefined : await read(ref);
          if (op.action === 'get') output = previous;
          if (op.action === 'create' || op.action === 'update') {
            const data: DocumentData = { ...(previous ?? {}), ...a.data };
            delete data.id;
            await validateReferences(resource, data, previous);
            if (resource === 'people' && !data.pack) data.pack = defaultPack();
            if (resource === 'items') {
              if (!previous) {
                const last = await tx.get(collection.orderBy('order', 'desc').limit(1));
                data.order = generateKeyBetween(last.docs[0]?.data().order ?? null, null);
                data.personIds ??= [];
                data.av ??= {};
                patch(session!, { itemCount: FieldValue.increment(1) });
              }
              Object.assign(data, stamp);
            }
            if (resource === 'sessions') {
              if (typeof data.startAt === 'string')
                data.startAt = Timestamp.fromDate(new Date(data.startAt));
              data.sortKey = data.startAt;
              data.itemCount ??= 0;
            }
            if (resource === 'templates') data.updatedAt = now;
            set(ref, data);
            output = { ...data, id: ref.id };
          }
          if (op.action === 'delete') {
            if (resource === 'tenants') {
              for (const child of ['events', 'categories', 'templates', 'exportJobs'])
                if (!(await tx.get(ref.collection(child).limit(1))).empty)
                  fail(
                    'failed-precondition',
                    'Organisation is not empty. Remove its data first; exported jobs require administrator cleanup.',
                  );
              for (const m of await all(ref.collection('members'))) {
                remove(m.ref);
                writes.push(() =>
                  tx.set(
                    db.doc(`users/${m.id}`),
                    {
                      tenantIds: FieldValue.arrayRemove(ref.id),
                      lastTenantId: FieldValue.delete(),
                    },
                    { merge: true },
                  ),
                );
              }
            }
            if (resource === 'events')
              for (const child of ['sessions', 'people'])
                if (!(await tx.get(ref.collection(child).limit(1))).empty)
                  fail('failed-precondition', 'Delete the event’s sessions and people first.');
            if (resource === 'sessions')
              for (const item of await all(ref.collection('items'))) remove(item.ref);
            if (resource === 'items') patch(session!, { itemCount: FieldValue.increment(-1) });
            if (resource === 'people') {
              const assigned = await eventItems(event!, (q) =>
                q.where('personIds', 'array-contains', a.id),
              );
              if (assigned.length && !a.removeAssignments)
                fail(
                  'failed-precondition',
                  'Person is assigned to items. Use removeAssignments=true to remove assignments and delete.',
                );
              for (const item of assigned)
                patch(item.ref, { personIds: FieldValue.arrayRemove(a.id), ...stamp });
            }
            if (resource === 'categories' || resource === 'templates') {
              if (resource === 'categories') {
                for (const t of await all(root!.collection('templates')))
                  if (t.data().filter?.categoryIds?.includes(a.id))
                    fail(
                      'failed-precondition',
                      'Category is used by a template. Archive it instead.',
                    );
              }
              for (const ev of await all(root!.collection('events'))) {
                if (
                  resource === 'categories' &&
                  (await eventItems(ev.ref, (q) => q.where('categoryId', '==', a.id))).length
                )
                  fail('failed-precondition', 'Category is used by items. Archive it instead.');
                if (resource === 'templates')
                  for (const p of await all(ev.ref.collection('people')))
                    if (
                      p
                        .data()
                        .pack?.templates?.some((r: { templateId: string }) => r.templateId === a.id)
                    )
                      fail(
                        'failed-precondition',
                        'Template is used by a pack. Remove it from packs first.',
                      );
              }
            }
            remove(ref);
            output = { id: ref.id, deleted: true };
          }
        }
      } else if (operation === 'members_list') output = await page(root!.collection('members'));
      else if (operation === 'members_set' || operation === 'members_remove') {
        if (a.uid === uid) fail('failed-precondition', 'You cannot change your own membership.');
        const ref = root!.collection('members').doc(a.uid),
          profile = db.doc(`users/${a.uid}`);
        const member = await tx.get(ref);
        const profileData = (await tx.get(profile)).data();
        if (operation === 'members_set') {
          const account = await this.auth
            .getUser(a.uid)
            .catch(() => fail('not-found', 'Firebase user not found. They must sign in first.'));
          if (
            !profileData?.tenantIds?.includes(tenantId) &&
            (profileData?.tenantIds?.length ?? 0) >= 100
          )
            fail('resource-exhausted', 'User already has 100 organisations.');
          set(ref, {
            role: a.role,
            displayName: account.displayName ?? '',
            email: account.email ?? '',
            addedAt: member.data()?.addedAt ?? now,
          });
          writes.push(() =>
            tx.set(profile, { tenantIds: FieldValue.arrayUnion(tenantId) }, { merge: true }),
          );
        } else {
          if (!member.exists) fail('not-found', 'Member not found.');
          remove(ref);
          writes.push(() =>
            tx.set(
              profile,
              {
                tenantIds: FieldValue.arrayRemove(tenantId),
                ...(profileData?.lastTenantId === tenantId
                  ? { lastTenantId: FieldValue.delete() }
                  : {}),
              },
              { merge: true },
            ),
          );
        }
        output = {
          uid: a.uid,
          ...(operation === 'members_set' ? { role: a.role } : { deleted: true }),
        };
      } else if (operation === 'packs_set') {
        const ref = event!.collection('people').doc(a.personId);
        await read(ref);
        await validateReferences('people', { pack: a.pack });
        patch(ref, { pack: a.pack });
        output = { id: a.personId, pack: a.pack };
      } else if (operation === 'items_reorder' || operation === 'items_duplicate') {
        const ref = session!.collection('items').doc(a.id),
          source = await read(ref);
        delete source.id;
        const rows = (await all(session!.collection('items').orderBy('order'))).filter(
          (d) => operation === 'items_duplicate' || d.id !== a.id,
        );
        const at =
          operation === 'items_duplicate' || a.beforeId === null
            ? rows.length
            : rows.findIndex((d) => d.id === a.beforeId);
        if (at < 0) fail('invalid-argument', 'beforeId must be another item in this session.');
        const order = generateKeyBetween(
          rows[at - 1]?.data().order ?? null,
          rows[at]?.data().order ?? null,
        );
        if (operation === 'items_reorder') {
          patch(ref, { order, ...stamp });
          output = { id: a.id, order };
        } else {
          await validateReferences('items', source, source);
          const copy = session!.collection('items').doc();
          set(copy, { ...source, order, ...stamp });
          patch(session!, { itemCount: FieldValue.increment(1) });
          output = { ...source, id: copy.id, order };
        }
      } else if (operation === 'templates_duplicate') {
        const source = await read(root!.collection('templates').doc(a.id));
        delete source.id;
        await validateReferences('templates', source);
        const target = root!.collection('templates').doc();
        set(target, {
          ...source,
          name: a.name ?? `${source.name.slice(0, 293)} (copy)`,
          updatedAt: now,
        });
        output = { id: target.id };
      } else if (operation === 'sessions_duplicate' || operation === 'sessions_move') {
        const sourceRef = event!.collection('sessions').doc(a.id),
          source = await read(sourceRef);
        delete source.id;
        const rows = await all(sourceRef.collection('items'));
        let destination = event!;
        const personMap = new Map<string, string>();
        if (operation === 'sessions_move') {
          if (a.destinationEventId === a.eventId)
            fail('invalid-argument', 'Choose a different destination event.');
          destination = root!.collection('events').doc(a.destinationEventId);
          await read(destination);
          const targetPeople = (await all(destination.collection('people'))).map(record);
          for (const personId of new Set<string>(rows.flatMap((i) => i.data().personIds))) {
            const person = await read(event!.collection('people').doc(personId));
            delete person.id;
            const match = targetPeople.find(
              (p) =>
                (person.email && p.email === person.email) ||
                (p.name === person.name && (p.role ?? '') === (person.role ?? '')),
            );
            if (match) personMap.set(personId, match.id);
            else {
              const target = destination.collection('people').doc();
              set(target, person);
              personMap.set(personId, target.id);
              targetPeople.push({ ...person, id: target.id });
            }
          }
        }
        const target = destination.collection('sessions').doc();
        set(target, {
          ...source,
          name:
            a.name ??
            (operation === 'sessions_duplicate'
              ? `${source.name.slice(0, 293)} (copy)`
              : source.name),
          itemCount: rows.length,
        });
        for (const row of rows) {
          set(target.collection('items').doc(row.id), {
            ...row.data(),
            ...(operation === 'sessions_move'
              ? { personIds: row.data().personIds.map((p: string) => personMap.get(p)) }
              : {}),
            ...stamp,
          });
          if (operation === 'sessions_move') remove(row.ref);
        }
        if (operation === 'sessions_move') remove(sourceRef);
        output = { id: target.id, eventId: destination.id, itemCount: rows.length };
      } else if (operation === 'sessions_rundown') {
        const data = await read(session!);
        const items = computeItems(
          (await all(session!.collection('items'))).map(record) as Item[],
          (await all(root!.collection('categories'))).map(record) as Category[],
          (await all(event!.collection('people'))).map(record) as Person[],
        );
        const runtimeSec = items.reduce((sum, item) => sum + item.durationSec, 0);
        output = {
          session: data,
          items,
          runtimeSec,
          endAt: new Date(data.startAt.toMillis() + runtimeSec * 1000).toISOString(),
        };
      } else if (operation === 'exports_list') output = await page(root!.collection('exportJobs'));
      else if (operation === 'exports_get')
        output = await read(root!.collection('exportJobs').doc(a.jobId));
      else fail('not-found', 'Operation is handled by a different endpoint.');
      if (writes.length > 450)
        fail(
          'resource-exhausted',
          'Operation exceeds 450 writes. Split the work into smaller operations.',
        );
      for (const write of writes) write();
      return output;
    });
    return serialize(result);
  }
}

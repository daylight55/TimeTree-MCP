import test from 'node:test';
import assert from 'node:assert/strict';
import { TimeTreeAPIClient } from '../.test-dist/client/api.js';

function makeEvent(overrides = {}) {
  return {
    id: overrides.uuid ?? 'event-1',
    uuid: overrides.uuid ?? 'event-1',
    calendar_id: 123,
    title: 'event',
    all_day: false,
    start_at: 1,
    end_at: 2,
    start_timezone: 'UTC',
    end_timezone: 'UTC',
    category: 1,
    alerts: [],
    recurrences: [],
    attendees: [],
    ...overrides,
  };
}

function makeClient(http) {
  return new TimeTreeAPIClient({
    isAuthenticated: () => true,
    authenticate: async () => {
      throw new Error('authenticate should not be called in unit tests');
    },
    getHttpClient: () => http,
    getCsrfToken: () => "test-token",
  });
}

test('deleteEvent uses no-body DELETE first', async () => {
  const calls = [];
  const client = makeClient({
    delete: async (url, body, _headers, requiresCsrf) => {
      calls.push({ url, body, requiresCsrf });
      return {};
    },
    get: async () => {
      throw new Error('sync fallback should not run after no-body delete succeeds');
    },
  });

  await client.deleteEvent('cal-1', 'event-1');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://timetreeapp.com/api/v1/calendar/cal-1/event/event-1');
  assert.equal(calls[0].body, undefined);
  assert.equal(calls[0].requiresCsrf, true);
});

test('deleteEvent falls back to full-event-body DELETE on non-404 no-body failure', async () => {
  const calls = [];
  let deleteCount = 0;
  const targetEvent = makeEvent({ uuid: 'event-1', title: 'target' });
  const client = makeClient({
    delete: async (url, body, _headers, requiresCsrf) => {
      deleteCount += 1;
      calls.push({ url, body, requiresCsrf });
      if (deleteCount === 1) {
        const error = new Error('bad request');
        error.statusCode = 400;
        throw error;
      }
      return {};
    },
    get: async (url) => {
      calls.push({ url, method: 'GET' });
      return { events: [targetEvent], chunk: false, since: 0 };
    },
  });

  await client.deleteEvent('cal-1', 'event-1');

  assert.equal(deleteCount, 2);
  assert.equal(calls[0].body, undefined);
  assert.equal(calls[1].url, 'https://timetreeapp.com/api/v1/calendar/cal-1/events/sync?since=0');
  assert.equal(calls[2].body.uuid, 'event-1');
  assert.equal(calls[2].requiresCsrf, true);
});

test('calendar metadata methods use verified endpoints and merge label updates', async () => {
  const calls = [];
  const client = makeClient({
    get: async (url) => {
      calls.push({ method: 'GET', url });
      if (url.endsWith('/labels')) {
        return {
          calendar_labels: [
            { id: 1, name: 'old', color: 111, default_color: 111 },
            { id: 2, name: 'keep', color: 222, default_color: 222 },
          ],
        };
      }
      if (url.endsWith('/users')) {
        return { calendar_users: [{ id: 10, user_id: 20, name: 'Member', role: 1, deactivated_at: null }] };
      }
      if (url.endsWith('/virtual_users')) {
        return { calendar_virtual_users: [{ id: 'v1', name: 'Virtual', calendar_id: 123, deactivated_at: null }] };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    put: async (url, body, _headers, requiresCsrf) => {
      calls.push({ method: 'PUT', url, body, requiresCsrf });
      return { calendar_labels: body.calendar_labels };
    },
  });

  const labels = await client.getCalendarLabels('123');
  const updated = await client.updateCalendarLabels('123', [{ id: 1, name: 'new' }]);
  const members = await client.getCalendarMembers('123');
  const virtualUsers = await client.getCalendarVirtualUsers('123');

  assert.equal(labels.length, 2);
  assert.deepEqual(updated, [
    { id: 1, name: 'new', color: 111 },
    { id: 2, name: 'keep', color: 222 },
  ]);
  assert.equal(members[0].user_id, 20);
  assert.equal(virtualUsers[0].id, 'v1');
  assert.equal(calls.find((call) => call.method === 'PUT').requiresCsrf, true);
  assert.ok(calls.some((call) => call.url === 'https://timetreeapp.com/api/v2/calendars/123/users'));
  assert.ok(calls.some((call) => call.url === 'https://timetreeapp.com/api/v1/calendars/123/virtual_users'));
});

test('event comment methods use activity endpoints and filter comment activities', async () => {
  const calls = [];
  const client = makeClient({
    post: async (url, body, _headers, requiresCsrf) => {
      calls.push({ method: 'POST', url, body, requiresCsrf });
      return { event_activity: { id: body.id, type: 0, event_id: 'evt', calendar_id: 123, attachment: body.attachment } };
    },
    get: async (url) => {
      calls.push({ method: 'GET', url });
      return {
        event_activities: [
          { id: 'system', type: 1, attachment: { items: [1] } },
          { id: 'comment', type: 0, attachment: { content: 'hello' }, deactivated_at: null },
          { id: 'deleted', type: 0, attachment: { content: 'gone' }, deactivated_at: 1 },
        ],
        since: 1,
      };
    },
    put: async (url, body, _headers, requiresCsrf) => {
      calls.push({ method: 'PUT', url, body, requiresCsrf });
      return { event_activity: { id: 'comment', type: 0, event_id: 'evt', calendar_id: 123, attachment: body.attachment } };
    },
    delete: async (url, body, _headers, requiresCsrf) => {
      calls.push({ method: 'DELETE', url, body, requiresCsrf });
      return {};
    },
  });

  const added = await client.addEventComment('123', 'evt', 'hello');
  const comments = await client.listEventComments('123', 'evt');
  const updated = await client.updateEventComment('123', 'evt', 'comment', 'updated');
  await client.deleteEventComment('123', 'evt', 'comment');

  assert.equal(added.attachment.content, 'hello');
  assert.equal(comments.length, 1);
  assert.equal(comments[0].id, 'comment');
  assert.equal(updated.attachment.content, 'updated');
  assert.ok(calls.every((call) => call.method === 'GET' || call.requiresCsrf === true));
  assert.ok(calls.some((call) => call.url === 'https://timetreeapp.com/api/v1/calendar/123/event/evt/activities'));
  assert.ok(calls.some((call) => call.url === 'https://timetreeapp.com/api/v1/calendar/123/event/evt/activity/comment'));
});

test('createCalendar uses v2 CSRF-protected creation without invitations or retries', async () => {
  const calls = [];
  const client = makeClient({post: async (...args) => {
    calls.push(args);
    return { calendar: {id: 456, name: 'Private', alias_code: 'new-alias'} };
  }});
  assert.equal((await client.createCalendar(' Private ', 'lover')).id, 456);
  assert.deepEqual(calls, [['https://timetreeapp.com/api/v2/calendars',
    {name: 'Private', purpose: 'lover'}, undefined, true]]);
  let count = 0;
  const failing = makeClient({post: async () => {count++; throw new Error('timeout');}});
  await assert.rejects(failing.createCalendar('Private'));
  assert.equal(count, 1);
});

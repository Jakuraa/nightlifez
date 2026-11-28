import crypto from "node:crypto";
import {
  calculatePriceBreakdown,
  canTransitionBookingStatus,
  canTransitionRefundStatus,
  createBookingSchema,
  createHoldSchema,
  createRefundRequestSchema,
  decideRefundSchema,
  getMinTierPrice,
  SEED_ACTIVITIES,
  SEED_ARTISTS,
  SEED_CITIES,
  SEED_COLLECTIONS,
  SEED_EVENTS,
  SEED_MOVIES,
  SEED_RESTAURANTS,
  SEED_VENUES,
  validateAttendeeQuestionAnswers,
  type Activity,
  type Artist,
  type BookingAttendeeRecord,
  type BookingRecord,
  type City,
  type CreateBookingInput,
  type EditorialCollection,
  type EventQueryInput,
  type InventoryHold,
  type Movie,
  type Offer,
  type PulseEvent,
  type RefundRequest,
  type Restaurant,
  type SavedItem,
  type TicketPass,
  type TicketTier,
  type Venue
} from "@nightlifez/shared";
import { signQrPayload } from "./auth.ts";
import { recordAuditLog } from "./authStore.ts";
import { getPool } from "./db.ts";
import { ensureSchemaBootstrapped } from "./bootstrapDb.ts";
import { getMemoryStore } from "./memoryStore.ts";
import { executeDemoPaymentAdapter, getOrganiserPaymentAdapter } from "./paymentAdapter.ts";
import { expireStaleUpiBookings, getPublicOrganiserPaymentInfo } from "./organiserPaymentService.ts";
import { listBookingAttendees, listEventQuestions } from "./sellerGuestService.ts";

const seedEventMap = new Map(SEED_EVENTS.map((e) => [e.slug, e]));
const seedVenueMap = new Map(SEED_VENUES.map((v) => [v.slug, v]));
const seedCityMap = new Map(SEED_CITIES.map((c) => [c.slug, c]));

function mapRowToEvent(
  row: Record<string, unknown>,
  tiers: TicketTier[],
  offers: Offer[]
): PulseEvent {
  const slug = String(row.slug);
  const seedFallback = seedEventMap.get(slug);
  return {
    id: String(row.id),
    slug,
    title: String(row.title),
    category: row.category as PulseEvent["category"],
    citySlug: String(row.city_slug),
    venueSlug: String(row.venue_slug),
    venueName: String(row.venue_name),
    organizationId: row.organization_id ? String(row.organization_id) : "org-nightlifez-originals",
    lifecycleStatus: (row.lifecycle_status as PulseEvent["lifecycleStatus"]) ?? "PUBLISHED",
    visibility: (row.visibility as PulseEvent["visibility"]) ?? "PUBLIC",
    approvalRequired: Boolean(row.approval_required),
    clonedFromEventId: row.cloned_from_event_id ? String(row.cloned_from_event_id) : null,
    moderationNotes: row.moderation_notes ? String(row.moderation_notes) : null,
    startsAt: new Date(String(row.starts_at)).toISOString(),
    endsAt: new Date(String(row.ends_at)).toISOString(),
    dateLabel: String(row.date_label),
    artworkUrl: row.artwork_url ? String(row.artwork_url) : seedFallback?.artworkUrl,
    ageLimit: row.age_limit ? String(row.age_limit) : seedFallback?.ageLimit,
    language: row.language ? String(row.language) : seedFallback?.language,
    durationLabel: row.duration_label ? String(row.duration_label) : seedFallback?.durationLabel,
    distanceKm:
      row.distance_km !== null && row.distance_km !== undefined
        ? Number(row.distance_km)
        : seedFallback?.distanceKm,
    sessions: seedFallback?.sessions,
    organizerName: String(row.organizer_name),
    organizerRating: Number(row.organizer_rating),
    organizerTenure: String(row.organizer_tenure),
    summary: String(row.summary),
    highlights: (row.highlights_json as PulseEvent["highlights"]) ?? [],
    facilities: (row.facilities_json as string[]) ?? [],
    policies: (row.policies_json as string[]) ?? [],
    lineup: ((row.lineup_json as PulseEvent["lineup"]) ?? []).map((l, idx) => ({
      ...l,
      slug: l.slug ?? seedFallback?.lineup[idx]?.slug,
      artworkUrl: l.artworkUrl ?? seedFallback?.lineup[idx]?.artworkUrl
    })),
    salesTimeline: (row.sales_timeline_json as PulseEvent["salesTimeline"]) ?? [],
    activePhase: row.active_phase as PulseEvent["activePhase"],
    partialReservePercent:
      row.partial_reserve_percent === null || row.partial_reserve_percent === undefined
        ? null
        : Number(row.partial_reserve_percent),
    isFeatured: Boolean(row.is_featured),
    accentColor: String(row.accent_color),
    tiers,
    offers
  };
}

function mapTierRow(row: Record<string, unknown>): TicketTier {
  return {
    id: String(row.id),
    sectionId: String(row.section_id),
    name: String(row.name),
    description: String(row.description),
    priceInr: Number(row.price_inr),
    totalQuota: Number(row.total_quota),
    remainingQuota: Number(row.remaining_quota),
    maxPerOrder: Number(row.max_per_order),
    salesPhase: row.sales_phase as TicketTier["salesPhase"],
    isActive: row.is_active === undefined ? true : Boolean(row.is_active)
  };
}

function mapOfferRow(row: Record<string, unknown>): Offer {
  return {
    id: String(row.id),
    code: String(row.code),
    title: String(row.title),
    description: String(row.description),
    kind: row.kind as Offer["kind"],
    discountValue: Number(row.discount_value),
    maxDiscountInr:
      row.max_discount_inr === null || row.max_discount_inr === undefined
        ? null
        : Number(row.max_discount_inr),
    minOrderInr: Number(row.min_order_inr),
    minQty: Number(row.min_qty),
    expiresAt: new Date(String(row.expires_at)).toISOString(),
    isActive: Boolean(row.is_active)
  };
}

function mapTicketRow(row: Record<string, unknown>): TicketPass {
  return {
    id: String(row.id),
    bookingId: String(row.booking_id),
    eventId: String(row.event_id),
    tierId: String(row.tier_id),
    tierName: String(row.tier_name),
    holderName: String(row.holder_name),
    holderEmail: String(row.holder_email),
    ticketCode: String(row.ticket_code),
    qrToken: String(row.qr_token),
    seatLabel: row.seat_label ? String(row.seat_label) : null,
    status: row.status as TicketPass["status"],
    checkedInAt: row.checked_in_at ? new Date(String(row.checked_in_at)).toISOString() : null,
    checkedInBy: row.checked_in_by ? String(row.checked_in_by) : null
  };
}

function filterAndSortEvents(events: PulseEvent[], query: EventQueryInput, includeNonPublished = false): PulseEvent[] {
  let result = events.filter(
    (e) =>
      includeNonPublished ||
      ((e.lifecycleStatus ?? "PUBLISHED") === "PUBLISHED" && (e.visibility ?? "PUBLIC") === "PUBLIC")
  );
  if (query.city && query.city !== "all") {
    result = result.filter((e) => e.citySlug === query.city);
  }
  if (query.category && query.category !== "all") {
    result = result.filter((e) => e.category === query.category);
  }
  if (query.q && query.q.trim().length > 0) {
    const needle = query.q.trim().toLowerCase();
    result = result.filter(
      (e) =>
        e.title.toLowerCase().includes(needle) ||
        e.venueName.toLowerCase().includes(needle) ||
        e.summary.toLowerCase().includes(needle) ||
        e.category.toLowerCase().includes(needle) ||
        e.lineup.some((a) => a.name.toLowerCase().includes(needle))
    );
  }
  if (query.dateWindow === "weekend") {
    result = result.filter((e) => {
      const day = new Date(e.startsAt).getUTCDay();
      return day === 0 || day === 6 || day === 5;
    });
  } else if (query.dateWindow === "today") {
    result = result.slice(0, 2);
  } else if (query.dateWindow === "tomorrow") {
    result = result.slice(1, 4);
  }

  if (query.maxPriceInr) {
    result = result.filter((e) => getMinTierPrice(e.tiers) <= query.maxPriceInr!);
  }
  if (query.maxDistanceKm) {
    result = result.filter((e) => (e.distanceKm ?? 5) <= query.maxDistanceKm!);
  }

  if (query.sort === "price_asc") {
    result.sort((a, b) => getMinTierPrice(a.tiers) - getMinTierPrice(b.tiers));
  } else if (query.sort === "price_desc") {
    result.sort((a, b) => getMinTierPrice(b.tiers) - getMinTierPrice(a.tiers));
  } else if (query.sort === "date_asc") {
    result.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  } else {
    result.sort((a, b) => Number(b.isFeatured) - Number(a.isFeatured));
  }
  return result;
}

export async function listCitiesAndEvents(
  query: EventQueryInput = {},
  options: { includeNonPublished?: boolean } = {}
): Promise<{ cities: City[]; events: PulseEvent[] }> {
  const pool = getPool();
  if (!pool) {
    const store = getMemoryStore();
    return {
      cities: store.cities,
      events: filterAndSortEvents(store.events, query, options.includeNonPublished)
    };
  }
  await ensureSchemaBootstrapped(pool);

  const [cityRes, evtRes, tierRes, offerRes] = await Promise.all([
    pool.query("SELECT slug, name, state, locality, is_popular FROM cities ORDER BY is_popular DESC, name ASC"),
    pool.query("SELECT * FROM events ORDER BY is_featured DESC, starts_at ASC"),
    pool.query("SELECT * FROM ticket_tiers ORDER BY price_inr ASC"),
    pool.query("SELECT * FROM offers ORDER BY min_order_inr ASC")
  ]);

  const tiersByEvt = new Map<string, TicketTier[]>();
  for (const row of tierRes.rows) {
    const eid = String(row.event_id);
    const arr = tiersByEvt.get(eid) ?? [];
    arr.push(mapTierRow(row));
    tiersByEvt.set(eid, arr);
  }

  const offersByEvt = new Map<string, Offer[]>();
  for (const row of offerRes.rows) {
    const eid = String(row.event_id);
    const arr = offersByEvt.get(eid) ?? [];
    arr.push(mapOfferRow(row));
    offersByEvt.set(eid, arr);
  }

  const cities: City[] = cityRes.rows.map((r) => {
    const slug = String(r.slug);
    return {
      slug,
      name: String(r.name),
      state: String(r.state),
      locality: r.locality ? String(r.locality) : seedCityMap.get(slug)?.locality,
      isPopular: Boolean(r.is_popular)
    };
  });

  const events = evtRes.rows.map((r) =>
    mapRowToEvent(r, tiersByEvt.get(String(r.id)) ?? [], offersByEvt.get(String(r.id)) ?? [])
  );

  return {
    cities,
    events: filterAndSortEvents(events, query, options.includeNonPublished)
  };
}

export async function getEventDetail(
  slug: string
): Promise<{ event: PulseEvent; venue: Venue | null } | null> {
  const { events } = await listCitiesAndEvents({}, {
    includeNonPublished: process.env.VERCEL_ENV !== "production"
  });
  const event = events.find((e) => e.slug === slug || e.id === slug);
  if (!event) return null;

  const venueData = await getVenueDetail(event.venueSlug);
  return { event, venue: venueData?.venue ?? null };
}

export async function listVenues(citySlug?: string): Promise<Venue[]> {
  const pool = getPool();
  if (!pool) {
    const venues = getMemoryStore().venues;
    if (!citySlug || citySlug === "all") return venues;
    return venues.filter((v) => v.citySlug === citySlug);
  }
  await ensureSchemaBootstrapped(pool);

  const res =
    !citySlug || citySlug === "all"
      ? await pool.query(
          process.env.VERCEL_ENV === "production"
            ? "SELECT * FROM venues WHERE approval_status = 'APPROVED' ORDER BY name ASC"
            : "SELECT * FROM venues ORDER BY name ASC"
        )
      : await pool.query(
          process.env.VERCEL_ENV === "production"
            ? "SELECT * FROM venues WHERE city_slug = $1 AND approval_status = 'APPROVED' ORDER BY name ASC"
            : "SELECT * FROM venues WHERE city_slug = $1 ORDER BY name ASC",
          [citySlug]
        );

  return res.rows.map((r) => {
    const slug = String(r.slug);
    const seedVenue = seedVenueMap.get(slug);
    return {
      slug,
      name: String(r.name),
      citySlug: String(r.city_slug),
      address: String(r.address),
      headline: String(r.headline),
      summary: String(r.summary),
      openStatusLabel: String(r.open_status_label),
      artworkUrl: r.artwork_url ? String(r.artwork_url) : seedVenue?.artworkUrl,
      distanceKm:
        r.distance_km !== null && r.distance_km !== undefined
          ? Number(r.distance_km)
          : seedVenue?.distanceKm,
      organizationId: r.organization_id ? String(r.organization_id) : null,
      approvalStatus: (r.approval_status as Venue["approvalStatus"]) ?? "APPROVED",
      policies: (r.policies_json as string[]) ?? [],
      capacityTotal: r.capacity_total ? Number(r.capacity_total) : 500,
      timings: (r.timings_json as Venue["timings"]) ?? [],
      facilities: (r.facilities_json as string[]) ?? [],
      sections: (r.sections_json as Venue["sections"]) ?? []
    };
  });
}

export async function getVenueDetail(
  slug: string
): Promise<{ venue: Venue; upcomingEvents: PulseEvent[] } | null> {
  const venues = await listVenues();
  const venue = venues.find((v) => v.slug === slug);
  if (!venue) return null;
  const { events } = await listCitiesAndEvents();
  return {
    venue,
    upcomingEvents: events.filter((e) => e.venueSlug === slug)
  };
}

export async function listArtists(city?: string): Promise<Artist[]> {
  if (process.env.VERCEL_ENV === "production") return [];
  if (!city || city === "all") return SEED_ARTISTS;
  return SEED_ARTISTS.filter((a) => a.citySlug === city);
}

export async function getArtistDetail(
  slug: string
): Promise<{ artist: Artist; events: PulseEvent[] } | null> {
  const artist = SEED_ARTISTS.find((a) => a.slug === slug);
  if (!artist) return null;
  const { events } = await listCitiesAndEvents();
  const matching = events.filter(
    (e) =>
      artist.upcomingEventSlugs.includes(e.slug) ||
      e.lineup.some((l) => l.name.toLowerCase() === artist.name.toLowerCase())
  );
  return { artist, events: matching };
}

export async function listMovies(filters?: {
  city?: string;
  language?: string;
  genre?: string;
  q?: string;
}): Promise<Movie[]> {
  let result = SEED_MOVIES.slice();
  if (filters?.language && filters.language !== "all") {
    result = result.filter((m) => m.language.toLowerCase() === filters.language!.toLowerCase());
  }
  if (filters?.genre && filters.genre !== "all") {
    result = result.filter((m) =>
      m.genres.some((g) => g.toLowerCase() === filters.genre!.toLowerCase())
    );
  }
  if (filters?.city && filters.city !== "all") {
    result = result.filter((m) => m.showtimes.some((s) => s.citySlug === filters.city));
  }
  if (filters?.q && filters.q.trim()) {
    const q = filters.q.trim().toLowerCase();
    result = result.filter(
      (m) =>
        m.title.toLowerCase().includes(q) ||
        m.language.toLowerCase().includes(q) ||
        m.genres.some((g) => g.toLowerCase().includes(q))
    );
  }
  return result;
}

export async function getMovieDetail(slug: string): Promise<Movie | null> {
  return SEED_MOVIES.find((m) => m.slug === slug) ?? null;
}

export async function listRestaurants(filters?: {
  city?: string;
  cuisine?: string;
  maxBudget?: number;
  q?: string;
}): Promise<Restaurant[]> {
  let result = SEED_RESTAURANTS.slice();
  if (filters?.city && filters.city !== "all") {
    result = result.filter((r) => r.citySlug === filters.city);
  }
  if (filters?.cuisine && filters.cuisine !== "all") {
    result = result.filter((r) =>
      r.cuisines.some((c) => c.toLowerCase().includes(filters.cuisine!.toLowerCase()))
    );
  }
  if (filters?.maxBudget) {
    result = result.filter((r) => r.budgetForTwoInr <= filters.maxBudget!);
  }
  if (filters?.q && filters.q.trim()) {
    const q = filters.q.trim().toLowerCase();
    result = result.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.locality.toLowerCase().includes(q) ||
        r.cuisines.some((c) => c.toLowerCase().includes(q))
    );
  }
  return result;
}

export async function getRestaurantDetail(slug: string): Promise<Restaurant | null> {
  return SEED_RESTAURANTS.find((r) => r.slug === slug) ?? null;
}

export async function listActivities(filters?: {
  city?: string;
  category?: string;
  q?: string;
}): Promise<Activity[]> {
  let result = SEED_ACTIVITIES.slice();
  if (filters?.city && filters.city !== "all") {
    result = result.filter((a) => a.citySlug === filters.city);
  }
  if (filters?.category && filters.category !== "all") {
    result = result.filter((a) => a.category === filters.category);
  }
  if (filters?.q && filters.q.trim()) {
    const q = filters.q.trim().toLowerCase();
    result = result.filter(
      (a) =>
        a.title.toLowerCase().includes(q) ||
        a.venueName.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q)
    );
  }
  return result;
}

export async function getActivityDetail(slug: string): Promise<Activity | null> {
  return SEED_ACTIVITIES.find((a) => a.slug === slug) ?? null;
}

export async function listCollections(): Promise<EditorialCollection[]> {
  return process.env.VERCEL_ENV === "production" ? [] : SEED_COLLECTIONS;
}

export async function expireStaleHolds(): Promise<number> {
  const nowMs = Date.now();
  const pool = getPool();
  if (!pool) {
    const store = getMemoryStore();
    let count = 0;
    for (const hold of store.holds) {
      if (hold.status === "ACTIVE" && new Date(hold.expiresAt).getTime() <= nowMs) {
        hold.status = "EXPIRED";
        const evt = store.events.find((e) => e.id === hold.eventId);
        const tier = evt?.tiers.find((t) => t.id === hold.tierId);
        if (tier) tier.remainingQuota += hold.quantity;
        count++;
      }
    }
    return count;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const expired = await client.query(
      `UPDATE inventory_holds SET status = 'EXPIRED'
       WHERE status = 'ACTIVE' AND expires_at <= NOW()
       RETURNING id, tier_id, quantity`
    );
    for (const row of expired.rows) {
      await client.query(
        "UPDATE ticket_tiers SET remaining_quota = remaining_quota + $1 WHERE id = $2",
        [Number(row.quantity), String(row.tier_id)]
      );
    }
    await client.query("COMMIT");
    return expired.rowCount ?? 0;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function createInventoryHold(
  rawInput: unknown,
  userId: string | null = null
): Promise<InventoryHold> {
  await expireStaleHolds();
  const input = createHoldSchema.parse(rawInput);
  const detail = await getEventDetail(input.eventSlug);
  if (!detail) throw new Error("Event not found.");
  const { event } = detail;

  const holdId = `hld_${crypto.randomUUID().slice(0, 12)}`;
  const holdToken = crypto.randomBytes(16).toString("hex");
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const seatLabels = input.seatLabels ?? [];

  const pool = getPool();
  if (!pool) {
    const tier = event.tiers.find((t) => t.id === input.tierId);
    if (!tier) throw new Error("Ticket tier not found.");
    if (input.quantity > tier.maxPerOrder) {
      throw new Error(`Maximum ${tier.maxPerOrder} tickets allowed per order for ${tier.name}.`);
    }
    if (tier.remainingQuota < input.quantity) {
      throw new Error(`Insufficient quota remaining for ${tier.name}.`);
    }
    tier.remainingQuota -= input.quantity;
    const hold: InventoryHold = {
      id: holdId,
      holdToken,
      userId,
      eventId: event.id,
      tierId: tier.id,
      quantity: input.quantity,
      seatLabels,
      status: "ACTIVE",
      expiresAt,
      createdAt
    };
    getMemoryStore().holds.unshift(hold);
    return hold;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tRes = await client.query(
      "SELECT id, name, remaining_quota, max_per_order FROM ticket_tiers WHERE id = $1 AND event_id = $2 FOR UPDATE",
      [input.tierId, event.id]
    );
    if (tRes.rowCount === 0) throw new Error("Ticket tier not found.");
    const row = tRes.rows[0];
    if (input.quantity > Number(row.max_per_order)) {
      throw new Error(`Maximum ${Number(row.max_per_order)} tickets allowed per order for ${String(row.name)}.`);
    }
    if (Number(row.remaining_quota) < input.quantity) {
      throw new Error(`Insufficient quota remaining for ${String(row.name)}.`);
    }
    await client.query(
      "UPDATE ticket_tiers SET remaining_quota = remaining_quota - $1 WHERE id = $2",
      [input.quantity, input.tierId]
    );
    await client.query(
      `INSERT INTO inventory_holds (id, hold_token, user_id, event_id, tier_id, quantity, seat_labels_json, status, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'ACTIVE',$8,$9)`,
      [holdId, holdToken, userId, event.id, input.tierId, input.quantity, JSON.stringify(seatLabels), expiresAt, createdAt]
    );
    await client.query("COMMIT");
    return {
      id: holdId,
      holdToken,
      userId,
      eventId: event.id,
      tierId: input.tierId,
      quantity: input.quantity,
      seatLabels,
      status: "ACTIVE",
      expiresAt,
      createdAt
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listBookings(filters?: {
  email?: string;
  userId?: string;
  organizationId?: string;
  eventId?: string;
}): Promise<BookingRecord[]> {
  const pool = getPool();
  if (!pool) {
    const store = getMemoryStore();
    let list = store.bookings.slice();
    if (filters?.email) {
      list = list.filter((b) => b.attendeeEmail.toLowerCase() === filters.email!.toLowerCase());
    }
    if (filters?.userId) {
      list = list.filter((b) => b.userId === filters.userId);
    }
    if (filters?.organizationId) {
      list = list.filter((b) => b.organizationId === filters.organizationId);
    }
    if (filters?.eventId) {
      list = list.filter((b) => b.eventId === filters.eventId);
    }
    return list.map((b) => ({
      ...b,
      attendees: store.bookingAttendees.filter((a) => a.bookingId === b.id),
      tickets: store.tickets.filter((t) => t.bookingId === b.id)
    }));
  }

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters?.email) {
    params.push(filters.email);
    clauses.push(`LOWER(attendee_email) = LOWER($${params.length})`);
  }
  if (filters?.userId) {
    params.push(filters.userId);
    clauses.push(`user_id = $${params.length}`);
  }
  if (filters?.organizationId) {
    params.push(filters.organizationId);
    clauses.push(`organization_id = $${params.length}`);
  }
  if (filters?.eventId) {
    params.push(filters.eventId);
    clauses.push(`event_id = $${params.length}`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const bRes = await pool.query(
    `SELECT * FROM bookings ${where} ORDER BY created_at DESC LIMIT 100`,
    params
  );
  if (bRes.rows.length === 0) return [];

  const ids = bRes.rows.map((r) => String(r.id));
  const [itemRes, ticketRes, attendeesByBooking] = await Promise.all([
    pool.query("SELECT * FROM booking_items WHERE booking_id = ANY($1::text[])", [ids]),
    pool.query("SELECT * FROM tickets WHERE booking_id = ANY($1::text[])", [ids]),
    listBookingAttendees(ids)
  ]);

  const itemsByBooking = new Map<string, BookingRecord["items"]>();
  for (const row of itemRes.rows) {
    const bid = String(row.booking_id);
    const arr = itemsByBooking.get(bid) ?? [];
    arr.push({
      tierId: String(row.tier_id),
      tierName: String(row.tier_name),
      quantity: Number(row.quantity),
      unitPriceInr: Number(row.unit_price_inr),
      seatLabels: (row.seat_labels_json as string[]) ?? []
    });
    itemsByBooking.set(bid, arr);
  }

  const ticketsByBooking = new Map<string, TicketPass[]>();
  for (const row of ticketRes.rows) {
    const t = mapTicketRow(row);
    const arr = ticketsByBooking.get(t.bookingId) ?? [];
    arr.push(t);
    ticketsByBooking.set(t.bookingId, arr);
  }

  return bRes.rows.map((r) => ({
    id: String(r.id),
    referenceCode: String(r.reference_code),
    userId: r.user_id ? String(r.user_id) : null,
    organizationId: r.organization_id ? String(r.organization_id) : null,
    attendeeEmail: String(r.attendee_email),
    attendeeName: String(r.attendee_name),
    eventId: String(r.event_id),
    eventSlug: String(r.event_slug),
    eventTitle: String(r.event_title),
    venueName: String(r.venue_name),
    dateLabel: String(r.date_label),
    offerCode: r.offer_code ? String(r.offer_code) : null,
    subtotalInr: Number(r.subtotal_inr),
    discountInr: Number(r.discount_inr),
    convenienceFeeInr: Number(r.convenience_fee_inr),
    gstInr: Number(r.gst_inr),
    totalInr: Number(r.total_inr),
    status: r.status as BookingRecord["status"],
    paymentMode: "DEMO_NO_CHARGE",
    paymentStatus: (r.payment_status as BookingRecord["paymentStatus"]) ?? "CONFIRMED",
    paymentRef: r.payment_ref ? String(r.payment_ref) : null,
    paymentChannel: (r.payment_channel as BookingRecord["paymentChannel"]) ?? "DEMO_SANDBOX",
    paymentSubmittedAt: r.payment_submitted_at ? new Date(String(r.payment_submitted_at)).toISOString() : null,
    paymentSubmittedRef: r.payment_submitted_ref ? String(r.payment_submitted_ref) : null,
    paymentVerifiedAt: r.payment_verified_at ? new Date(String(r.payment_verified_at)).toISOString() : null,
    paymentVerifiedBy: r.payment_verified_by ? String(r.payment_verified_by) : null,
    paymentRejectionReason: r.payment_rejection_reason ? String(r.payment_rejection_reason) : null,
    paymentExpiresAt: r.payment_expires_at ? new Date(String(r.payment_expires_at)).toISOString() : null,
    referralCode: r.referral_code ? String(r.referral_code) : null,
    bookingSource: (r.booking_source as BookingRecord["bookingSource"]) ?? "ONLINE",
    approvalStatus: (r.approval_status as BookingRecord["approvalStatus"]) ?? "NOT_REQUIRED",
    approvalToken: r.approval_token ? String(r.approval_token) : null,
    approvalExpiresAt: r.approval_expires_at ? new Date(String(r.approval_expires_at)).toISOString() : null,
    approvedAt: r.approved_at ? new Date(String(r.approved_at)).toISOString() : null,
    rejectedAt: r.rejected_at ? new Date(String(r.rejected_at)).toISOString() : null,
    approvedBy: r.approved_by ? String(r.approved_by) : null,
    rejectionReason: r.rejection_reason ? String(r.rejection_reason) : null,
    cancellationReason: r.cancellation_reason ? String(r.cancellation_reason) : null,
    cancelledAt: r.cancelled_at ? new Date(String(r.cancelled_at)).toISOString() : null,
    createdAt: new Date(String(r.created_at)).toISOString(),
    items: itemsByBooking.get(String(r.id)) ?? [],
    attendees: attendeesByBooking.get(String(r.id)) ?? [],
    tickets: ticketsByBooking.get(String(r.id)) ?? []
  }));
}

export async function createDemoBooking(
  rawInput: CreateBookingInput,
  options: { userId?: string | null } = {}
): Promise<BookingRecord> {
  await expireStaleHolds();
  await expireStaleUpiBookings();
  const input = createBookingSchema.parse(rawInput);
  const detail = await getEventDetail(input.eventSlug);
  if (!detail) {
    throw new Error("Event not found.");
  }
  const { event } = detail;
  if ((event.lifecycleStatus ?? "PUBLISHED") !== "PUBLISHED") {
    throw new Error("Event is not currently open for ticket bookings.");
  }

  const breakdown = calculatePriceBreakdown({
    tiers: event.tiers,
    selections: input.items,
    offers: event.offers,
    offerCode: input.offerCode
  });

  if (breakdown.totalQuantity <= 0 || breakdown.totalQuantity > 10) {
    throw new Error("Total ticket quantity must be between 1 and 10 per order.");
  }
  if (input.offerCode && breakdown.offerRejectionReason) {
    throw new Error(breakdown.offerRejectionReason);
  }

  const questions = await listEventQuestions(event.id);
  const rawAttendees = input.attendees && input.attendees.length > 0
    ? input.attendees
    : input.items.flatMap((item) =>
        Array.from({ length: item.quantity }, () => ({
          tierId: item.tierId,
          fullName: input.attendeeName,
          email: input.attendeeEmail,
          phone: null,
          answers: {}
        }))
      );

  if (rawAttendees.length !== breakdown.totalQuantity) {
    throw new Error(`Expected ${breakdown.totalQuantity} attendee record(s), received ${rawAttendees.length}.`);
  }

  const validatedAttendees: Omit<BookingAttendeeRecord, "id" | "bookingId" | "ticketId" | "createdAt">[] = [];
  for (let idx = 0; idx < rawAttendees.length; idx++) {
    const att = rawAttendees[idx]!;
    const qValidation = validateAttendeeQuestionAnswers(questions, att.answers, `Attendee ${idx + 1} (${att.fullName})`);
    if (!qValidation.valid) {
      throw new Error(qValidation.errors.join(" "));
    }
    validatedAttendees.push({
      eventId: event.id,
      tierId: att.tierId,
      attendeeIndex: idx,
      fullName: att.fullName,
      email: att.email.toLowerCase(),
      phone: att.phone ?? null,
      answers: qValidation.sanitized
    });
  }

  const requiresApproval = Boolean(event.approvalRequired);
  const isDirectUpi = !requiresApproval && input.paymentChannel === "ORGANISER_UPI";
  const deferTickets = requiresApproval || isDirectUpi;
  const orgId = event.organizationId ?? "org-nightlifez-originals";
  const bookingId = `bkg_${crypto.randomUUID().slice(0, 12)}`;
  const refCode = `NLZ-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  const nowIso = new Date().toISOString();
  const paymentExpiresAtIso = isDirectUpi ? new Date(Date.now() + 30 * 60 * 1000).toISOString() : null;

  let paymentAttempt: { state: "PENDING" | "CONFIRMED" | "FAILED"; transactionRef: string | null; message: string };
  if (requiresApproval) {
    paymentAttempt = { state: "PENDING", transactionRef: null, message: "Awaiting organiser approval before payment." };
  } else if (isDirectUpi) {
    const upiInfo = await getPublicOrganiserPaymentInfo(orgId);
    if (!upiInfo.upiEnabled || !upiInfo.upiId || !upiInfo.payeeDisplayName) {
      throw new Error("Direct UPI is not enabled for this organiser.");
    }
    const adapter = getOrganiserPaymentAdapter("ORGANISER_UPI");
    const initRes = await adapter.initiatePayment({
      amountInr: breakdown.totalInr,
      referenceCode: refCode,
      upiId: upiInfo.upiId,
      payeeDisplayName: upiInfo.payeeDisplayName
    });
    paymentAttempt = { state: initRes.state as "PENDING", transactionRef: initRes.transactionRef, message: initRes.message };
  } else {
    if (process.env.VERCEL_ENV === "production") {
      throw new Error("Organiser Direct UPI payment is required in production.");
    }
    const demoRes = await executeDemoPaymentAdapter({
      amountInr: breakdown.totalInr,
      simulateOutcome: input.simulatePaymentOutcome
    });
    paymentAttempt = { state: demoRes.state as "CONFIRMED" | "FAILED", transactionRef: demoRes.transactionRef, message: demoRes.message };
    if (paymentAttempt.state === "FAILED") {
      throw new Error(paymentAttempt.message);
    }
  }

  const pool = getPool();
  if (!pool) {
    const store = getMemoryStore();
    if (input.idempotencyKey) {
      const existingId = store.idempotencyIndex.get(input.idempotencyKey);
      if (existingId) {
        const existing = store.bookings.find((b) => b.id === existingId);
        if (existing) {
          return { ...existing, tickets: store.tickets.filter((t) => t.bookingId === existing.id) };
        }
      }
    }

    let activeHold: InventoryHold | undefined;
    if (input.holdId) {
      activeHold = store.holds.find(
        (h) => h.id === input.holdId && h.status === "ACTIVE" && new Date(h.expiresAt).getTime() > Date.now()
      );
      if (!activeHold) {
        throw new Error("Ticket hold has expired or is invalid.");
      }
    }

    const items: BookingRecord["items"] = [];
    for (const sel of input.items) {
      const tier = event.tiers.find((t) => t.id === sel.tierId);
      if (!tier) throw new Error(`Unknown ticket tier: ${sel.tierId}`);
      if (sel.quantity > tier.maxPerOrder) {
        throw new Error(`Maximum ${tier.maxPerOrder} tickets allowed for ${tier.name}.`);
      }
      const coveredByHold =
        !requiresApproval && activeHold && activeHold.tierId === tier.id
          ? Math.min(sel.quantity, activeHold.quantity)
          : 0;
      const netDelta = sel.quantity - coveredByHold;
      if (tier.remainingQuota < netDelta) {
        throw new Error(`Insufficient quota remaining for ${tier.name}.`);
      }
      if (!requiresApproval) {
        tier.remainingQuota -= netDelta;
      }
      items.push({
        tierId: tier.id,
        tierName: tier.name,
        quantity: sel.quantity,
        unitPriceInr: tier.priceInr,
        seatLabels: sel.seatLabels ?? []
      });
    }

    if (activeHold && !requiresApproval) {
      activeHold.status = "CONVERTED";
    }

    const tickets: TicketPass[] = [];
    const attendeeRecords: BookingAttendeeRecord[] = [];
    let attCursor = 0;

    if (!deferTickets) {
      for (const item of items) {
        for (let i = 0; i < item.quantity; i++) {
          const vAtt = validatedAttendees[attCursor++];
          const ticketId = `tkt_${crypto.randomUUID().slice(0, 12)}`;
          const ticketCode = `NLZ-TKT-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
          const seatLabel = item.seatLabels?.[i] ?? null;
          tickets.push({
            id: ticketId,
            bookingId,
            eventId: event.id,
            eventTitle: event.title,
            tierId: item.tierId,
            tierName: item.tierName,
            holderName: vAtt?.fullName ?? input.attendeeName,
            holderEmail: vAtt?.email ?? input.attendeeEmail,
            ticketCode,
            qrToken: signQrPayload(ticketId, event.id, ticketCode),
            seatLabel,
            status: "VALID",
            checkedInAt: null,
            checkedInBy: null
          });
          if (vAtt) {
            attendeeRecords.push({
              id: `att_${crypto.randomUUID().slice(0, 10)}`,
              bookingId,
              ...vAtt,
              ticketId,
              createdAt: nowIso
            });
          }
        }
      }
    } else {
      for (const vAtt of validatedAttendees) {
        attendeeRecords.push({
          id: `att_${crypto.randomUUID().slice(0, 10)}`,
          bookingId,
          ...vAtt,
          ticketId: null,
          createdAt: nowIso
        });
      }
    }

    const record: BookingRecord = {
      id: bookingId,
      referenceCode: refCode,
      userId: options.userId ?? null,
      organizationId: orgId,
      attendeeEmail: input.attendeeEmail,
      attendeeName: input.attendeeName,
      eventId: event.id,
      eventSlug: event.slug,
      eventTitle: event.title,
      venueName: event.venueName,
      dateLabel: event.dateLabel,
      offerCode: breakdown.appliedOfferCode,
      subtotalInr: breakdown.subtotalInr,
      discountInr: breakdown.discountInr,
      convenienceFeeInr: breakdown.convenienceFeeInr,
      gstInr: breakdown.gstInr,
      totalInr: breakdown.totalInr,
      status: requiresApproval
        ? "PENDING_APPROVAL"
        : isDirectUpi
        ? "AWAITING_PAYMENT_VERIFICATION"
        : "CONFIRMED_DEMO",
      paymentMode: "DEMO_NO_CHARGE",
      paymentStatus: deferTickets ? "PENDING" : "CONFIRMED",
      paymentRef: paymentAttempt.transactionRef,
      paymentChannel: isDirectUpi ? "ORGANISER_UPI" : "DEMO_SANDBOX",
      paymentExpiresAt: paymentExpiresAtIso,
      referralCode: input.referralCode?.trim().toUpperCase() || null,
      bookingSource: "ONLINE",
      approvalStatus: requiresApproval ? "PENDING_APPROVAL" : "NOT_REQUIRED",
      createdAt: nowIso,
      items,
      attendees: attendeeRecords,
      tickets
    };
    store.bookings.unshift(record);
    store.bookingAttendees.push(...attendeeRecords);
    store.tickets.push(...tickets);
    if (input.idempotencyKey) {
      store.idempotencyIndex.set(input.idempotencyKey, bookingId);
    }

    if (requiresApproval) {
      store.notifications.unshift({
        id: `ntf_${crypto.randomUUID().slice(0, 10)}`,
        userId: null,
        audience: "ORGANISER",
        title: `Approval request: ${event.title}`,
        body: `${input.attendeeName} (${refCode}) requested ${breakdown.totalQuantity} pass(es).`,
        kind: "BOOKING",
        isRead: false,
        createdAt: nowIso
      });
    } else if (!isDirectUpi) {
      store.ledger.unshift(
      {
        id: `led_${crypto.randomUUID().slice(0, 10)}`,
        organizationId: record.organizationId ?? null,
        bookingId,
        refundId: null,
        settlementId: null,
        entryType: "TICKET_SALE",
        amountInr: Math.max(0, breakdown.subtotalInr - breakdown.discountInr),
        currency: "INR",
        mode: "DEMO_LEDGER",
        note: `Demo ticket sale ${refCode}`,
        createdAt: nowIso
      },
      {
        id: `led_${crypto.randomUUID().slice(0, 10)}`,
        organizationId: record.organizationId ?? null,
        bookingId,
        refundId: null,
        settlementId: null,
        entryType: "PLATFORM_FEE",
        amountInr: breakdown.convenienceFeeInr,
        currency: "INR",
        mode: "DEMO_LEDGER",
        note: `Platform convenience fee ${refCode}`,
        createdAt: nowIso
      },
      {
        id: `led_${crypto.randomUUID().slice(0, 10)}`,
        organizationId: record.organizationId ?? null,
        bookingId,
        refundId: null,
        settlementId: null,
        entryType: "GST",
        amountInr: breakdown.gstInr,
        currency: "INR",
        mode: "DEMO_LEDGER",
        note: `GST on platform fee ${refCode}`,
        createdAt: nowIso
      }
    );
    }

    return record;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (input.idempotencyKey) {
      const existing = await client.query(
        "SELECT id FROM bookings WHERE idempotency_key = $1 LIMIT 1",
        [input.idempotencyKey]
      );
      if ((existing.rowCount ?? 0) > 0) {
        await client.query("ROLLBACK");
        const existingId = String(existing.rows[0].id);
        const all = await listBookings();
        const found = all.find((b) => b.id === existingId);
        if (found) return found;
      }
    }

    let holdRow: Record<string, unknown> | null = null;
    if (input.holdId) {
      const hRes = await client.query(
        "SELECT * FROM inventory_holds WHERE id = $1 FOR UPDATE",
        [input.holdId]
      );
      if (hRes.rowCount === 0) throw new Error("Ticket hold not found.");
      const h = hRes.rows[0];
      if (String(h.status) !== "ACTIVE" || new Date(String(h.expires_at)).getTime() <= Date.now()) {
        throw new Error("Ticket hold has expired.");
      }
      holdRow = h;
    }

    const items: BookingRecord["items"] = [];
    for (const sel of input.items) {
      const tRes = await client.query(
        "SELECT id, name, price_inr, remaining_quota, max_per_order FROM ticket_tiers WHERE id = $1 AND event_id = $2 FOR UPDATE",
        [sel.tierId, event.id]
      );
      if (tRes.rowCount === 0) throw new Error(`Unknown ticket tier: ${sel.tierId}`);
      const row = tRes.rows[0];
      if (sel.quantity > Number(row.max_per_order)) {
        throw new Error(`Maximum ${Number(row.max_per_order)} tickets allowed for ${String(row.name)}.`);
      }
      const coveredByHold =
        !requiresApproval && holdRow && String(holdRow.tier_id) === sel.tierId
          ? Math.min(sel.quantity, Number(holdRow.quantity))
          : 0;
      const netDelta = sel.quantity - coveredByHold;
      if (Number(row.remaining_quota) < netDelta) {
        throw new Error(`Insufficient quota remaining for ${String(row.name)}.`);
      }
      if (!requiresApproval && netDelta !== 0) {
        await client.query(
          "UPDATE ticket_tiers SET remaining_quota = remaining_quota - $1 WHERE id = $2",
          [netDelta, sel.tierId]
        );
      }
      items.push({
        tierId: String(row.id),
        tierName: String(row.name),
        quantity: sel.quantity,
        unitPriceInr: Number(row.price_inr),
        seatLabels: sel.seatLabels ?? []
      });
    }

    if (holdRow && !requiresApproval) {
      await client.query("UPDATE inventory_holds SET status = 'CONVERTED' WHERE id = $1", [
        String(holdRow.id)
      ]);
    }

    const insertRes = await client.query(
      `INSERT INTO bookings (
         id, reference_code, user_id, organization_id, idempotency_key, hold_id,
         attendee_email, attendee_name, event_id, event_slug,
         event_title, venue_name, date_label, offer_code, subtotal_inr, discount_inr,
         convenience_fee_inr, gst_inr, total_inr, status, payment_mode, payment_status, payment_ref,
         approval_status, booking_source, payment_channel, payment_expires_at, referral_code
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'DEMO_NO_CHARGE',$21,$22,$23,'ONLINE',$24,$25,$26)
       RETURNING created_at`,
      [
        bookingId,
        refCode,
        options.userId ?? null,
        orgId,
        input.idempotencyKey ?? null,
        input.holdId ?? null,
        input.attendeeEmail,
        input.attendeeName,
        event.id,
        event.slug,
        event.title,
        event.venueName,
        event.dateLabel,
        breakdown.appliedOfferCode,
        breakdown.subtotalInr,
        breakdown.discountInr,
        breakdown.convenienceFeeInr,
        breakdown.gstInr,
        breakdown.totalInr,
        requiresApproval
          ? "PENDING_APPROVAL"
          : isDirectUpi
          ? "AWAITING_PAYMENT_VERIFICATION"
          : "CONFIRMED_DEMO",
        deferTickets ? "PENDING" : "CONFIRMED",
        paymentAttempt.transactionRef,
        requiresApproval ? "PENDING_APPROVAL" : "NOT_REQUIRED",
        isDirectUpi ? "ORGANISER_UPI" : "DEMO_SANDBOX",
        paymentExpiresAtIso,
        input.referralCode?.trim().toUpperCase() || null
      ]
    );

    const tickets: TicketPass[] = [];
    const attendeeRecords: BookingAttendeeRecord[] = [];
    let attCursor = 0;
    for (const item of items) {
      await client.query(
        `INSERT INTO booking_items (booking_id, tier_id, tier_name, quantity, unit_price_inr, seat_labels_json)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [bookingId, item.tierId, item.tierName, item.quantity, item.unitPriceInr, JSON.stringify(item.seatLabels ?? [])]
      );

      for (let i = 0; i < item.quantity; i++) {
        const vAtt = validatedAttendees[attCursor++];
        let issuedTicketId: string | null = null;
        if (!deferTickets) {
          const ticketId = `tkt_${crypto.randomUUID().slice(0, 12)}`;
          const ticketCode = `NLZ-TKT-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
          const qrToken = signQrPayload(ticketId, event.id, ticketCode);
          const seatLabel = item.seatLabels?.[i] ?? null;
          await client.query(
            `INSERT INTO tickets (id, booking_id, event_id, tier_id, tier_name, holder_name, holder_email, ticket_code, qr_token, seat_label, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'VALID')`,
            [ticketId, bookingId, event.id, item.tierId, item.tierName, vAtt?.fullName ?? input.attendeeName, vAtt?.email ?? input.attendeeEmail, ticketCode, qrToken, seatLabel]
          );
          issuedTicketId = ticketId;
          tickets.push({
            id: ticketId,
            bookingId,
            eventId: event.id,
            eventTitle: event.title,
            tierId: item.tierId,
            tierName: item.tierName,
            holderName: vAtt?.fullName ?? input.attendeeName,
            holderEmail: vAtt?.email ?? input.attendeeEmail,
            ticketCode,
            qrToken,
            seatLabel,
            status: "VALID",
            checkedInAt: null,
            checkedInBy: null
          });
        }
        if (vAtt) {
          const attId = `att_${crypto.randomUUID().slice(0, 10)}`;
          await client.query(
            `INSERT INTO booking_attendees (id, booking_id, event_id, tier_id, attendee_index, full_name, email, phone, answers_json, ticket_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
            [attId, bookingId, event.id, item.tierId, vAtt.attendeeIndex, vAtt.fullName, vAtt.email, vAtt.phone, JSON.stringify(vAtt.answers), issuedTicketId]
          );
          attendeeRecords.push({
            id: attId,
            bookingId,
            ...vAtt,
            ticketId: issuedTicketId,
            createdAt: nowIso
          });
        }
      }
    }

    if (isDirectUpi) {
      await client.query(
        `INSERT INTO payment_records (id, booking_id, provider, mode, amount_inr, state, transaction_ref)
         VALUES ($1,$2,'DIRECT_UPI','DIRECT_ORGANISER_UPI',$3,'PENDING',$4)`,
        [`pay_${crypto.randomUUID().slice(0, 10)}`, bookingId, breakdown.totalInr, refCode]
      );
    } else if (!requiresApproval) {
      await client.query(
        `INSERT INTO payment_records (id, booking_id, provider, mode, amount_inr, state, transaction_ref)
         VALUES ($1,$2,'DEMO_SANDBOX','DEMO_NO_CHARGE',$3,'CONFIRMED',$4)`,
        [`pay_${crypto.randomUUID().slice(0, 10)}`, bookingId, breakdown.totalInr, paymentAttempt.transactionRef]
      );

      const netSale = Math.max(0, breakdown.subtotalInr - breakdown.discountInr);
      await client.query(
        `INSERT INTO ledger_entries (id, organization_id, booking_id, entry_type, amount_inr, note)
         VALUES ($1,$2,$3,'TICKET_SALE',$4,$5), ($6,$2,$3,'PLATFORM_FEE',$7,$8), ($9,$2,$3,'GST',$10,$11)`,
        [
          `led_${crypto.randomUUID().slice(0, 10)}`,
          orgId,
          bookingId,
          netSale,
          `Demo ticket sale ${refCode}`,
          `led_${crypto.randomUUID().slice(0, 10)}`,
          breakdown.convenienceFeeInr,
          `Platform convenience fee ${refCode}`,
          `led_${crypto.randomUUID().slice(0, 10)}`,
          breakdown.gstInr,
          `GST on platform fee ${refCode}`
        ]
      );
    } else {
      await client.query(
        `INSERT INTO notifications (id, user_id, audience, title, body, kind, is_read, created_at)
         VALUES ($1,NULL,'ORGANISER',$2,$3,'BOOKING',FALSE,$4)`,
        [
          `ntf_${crypto.randomUUID().slice(0, 10)}`,
          `Approval request: ${event.title}`,
          `${input.attendeeName} (${refCode}) requested ${breakdown.totalQuantity} pass(es).`,
          nowIso
        ]
      );
    }

    await client.query("COMMIT");
    return {
      id: bookingId,
      referenceCode: refCode,
      userId: options.userId ?? null,
      organizationId: orgId,
      attendeeEmail: input.attendeeEmail,
      attendeeName: input.attendeeName,
      eventId: event.id,
      eventSlug: event.slug,
      eventTitle: event.title,
      venueName: event.venueName,
      dateLabel: event.dateLabel,
      offerCode: breakdown.appliedOfferCode,
      subtotalInr: breakdown.subtotalInr,
      discountInr: breakdown.discountInr,
      convenienceFeeInr: breakdown.convenienceFeeInr,
      gstInr: breakdown.gstInr,
      totalInr: breakdown.totalInr,
      status: requiresApproval
        ? "PENDING_APPROVAL"
        : isDirectUpi
        ? "AWAITING_PAYMENT_VERIFICATION"
        : "CONFIRMED_DEMO",
      paymentMode: "DEMO_NO_CHARGE",
      paymentStatus: deferTickets ? "PENDING" : "CONFIRMED",
      paymentRef: paymentAttempt.transactionRef,
      paymentChannel: isDirectUpi ? "ORGANISER_UPI" : "DEMO_SANDBOX",
      paymentExpiresAt: paymentExpiresAtIso,
      referralCode: input.referralCode?.trim().toUpperCase() || null,
      bookingSource: "ONLINE",
      approvalStatus: requiresApproval ? "PENDING_APPROVAL" : "NOT_REQUIRED",
      createdAt: new Date(String(insertRes.rows[0].created_at)).toISOString(),
      items,
      attendees: attendeeRecords,
      tickets
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function cancelDemoBooking(id: string, reason?: string): Promise<BookingRecord> {
  const nowIso = new Date().toISOString();
  const pool = getPool();
  if (!pool) {
    const store = getMemoryStore();
    const existing = store.bookings.find((b) => b.id === id);
    if (!existing) throw new Error("Booking not found.");
    if (existing.status === "CANCELLED") return existing;
    if (!canTransitionBookingStatus(existing.status, "CANCELLED")) {
      throw new Error(`Cannot cancel booking in state ${existing.status}.`);
    }
    const prevStatus = existing.status;
    existing.status = "CANCELLED";
    existing.cancellationReason = reason ?? "Cancelled by attendee";
    existing.cancelledAt = nowIso;
    if (prevStatus === "CONFIRMED_DEMO" || prevStatus === "AWAITING_PAYMENT_VERIFICATION") {
      const evt = store.events.find((e) => e.id === existing.eventId);
      if (evt) {
        for (const item of existing.items) {
          const tier = evt.tiers.find((t) => t.id === item.tierId);
          if (tier) tier.remainingQuota += item.quantity;
        }
      }
    }
    for (const t of store.tickets) {
      if (t.bookingId === id && t.status === "VALID") {
        t.status = "CANCELLED";
      }
    }
    return { ...existing, tickets: store.tickets.filter((t) => t.bookingId === id) };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const bRes = await client.query("SELECT * FROM bookings WHERE id = $1 FOR UPDATE", [id]);
    if (bRes.rowCount === 0) throw new Error("Booking not found.");
    const row = bRes.rows[0];
    const currentStatus = String(row.status) as BookingRecord["status"];
    if (!canTransitionBookingStatus(currentStatus, "CANCELLED")) {
      throw new Error(`Cannot cancel booking in state ${currentStatus}.`);
    }
    const itemRes = await client.query("SELECT * FROM booking_items WHERE booking_id = $1", [id]);

    if (currentStatus !== "CANCELLED") {
      await client.query(
        "UPDATE bookings SET status = 'CANCELLED', cancellation_reason = $2, cancelled_at = $3 WHERE id = $1",
        [id, reason ?? "Cancelled by attendee", nowIso]
      );
      await client.query(
        "UPDATE tickets SET status = 'CANCELLED' WHERE booking_id = $1 AND status = 'VALID'",
        [id]
      );
      if (currentStatus === "CONFIRMED_DEMO" || currentStatus === "AWAITING_PAYMENT_VERIFICATION") {
        for (const item of itemRes.rows) {
          await client.query(
            "UPDATE ticket_tiers SET remaining_quota = remaining_quota + $1 WHERE id = $2",
            [Number(item.quantity), String(item.tier_id)]
          );
        }
      }
    }

    const ticketRes = await client.query("SELECT * FROM tickets WHERE booking_id = $1", [id]);
    await client.query("COMMIT");
    return {
      id: String(row.id),
      referenceCode: String(row.reference_code),
      userId: row.user_id ? String(row.user_id) : null,
      organizationId: row.organization_id ? String(row.organization_id) : null,
      attendeeEmail: String(row.attendee_email),
      attendeeName: String(row.attendee_name),
      eventId: String(row.event_id),
      eventSlug: String(row.event_slug),
      eventTitle: String(row.event_title),
      venueName: String(row.venue_name),
      dateLabel: String(row.date_label),
      offerCode: row.offer_code ? String(row.offer_code) : null,
      subtotalInr: Number(row.subtotal_inr),
      discountInr: Number(row.discount_inr),
      convenienceFeeInr: Number(row.convenience_fee_inr),
      gstInr: Number(row.gst_inr),
      totalInr: Number(row.total_inr),
      status: "CANCELLED",
      paymentMode: "DEMO_NO_CHARGE",
      paymentStatus: (row.payment_status as BookingRecord["paymentStatus"]) ?? "CANCELLED",
      cancellationReason: reason ?? "Cancelled by attendee",
      cancelledAt: nowIso,
      createdAt: new Date(String(row.created_at)).toISOString(),
      items: itemRes.rows.map((item) => ({
        tierId: String(item.tier_id),
        tierName: String(item.tier_name),
        quantity: Number(item.quantity),
        unitPriceInr: Number(item.unit_price_inr),
        seatLabels: (item.seat_labels_json as string[]) ?? []
      })),
      tickets: ticketRes.rows.map(mapTicketRow)
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function createRefundRequest(
  rawInput: unknown,
  userId: string | null
): Promise<RefundRequest> {
  const input = createRefundRequestSchema.parse(rawInput);
  const bookings = await listBookings();
  const booking = bookings.find((b) => b.id === input.bookingId);
  if (!booking) throw new Error("Booking not found.");
  if (userId && booking.userId && booking.userId !== userId) {
    throw new Error("You can only request a refund for your own booking.");
  }
  if (!canTransitionBookingStatus(booking.status, "REFUND_PENDING")) {
    throw new Error(`Refund cannot be requested when booking is ${booking.status}.`);
  }

  const now = new Date().toISOString();
  const refund: RefundRequest = {
    id: `rfd_${crypto.randomUUID().slice(0, 12)}`,
    bookingId: booking.id,
    userId: userId ?? booking.userId ?? null,
    organizationId: booking.organizationId ?? null,
    amountInr: booking.totalInr,
    reason: input.reason,
    status: "REQUESTED",
    reviewedBy: null,
    resolutionNote: null,
    createdAt: now,
    updatedAt: now
  };

  const pool = getPool();
  if (!pool) {
    const store = getMemoryStore();
    const b = store.bookings.find((x) => x.id === booking.id);
    if (b) b.status = "REFUND_PENDING";
    store.refunds.unshift(refund);
    return refund;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE bookings SET status = 'REFUND_PENDING' WHERE id = $1", [booking.id]);
    await client.query(
      `INSERT INTO refund_requests (id, booking_id, user_id, organization_id, amount_inr, reason, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'REQUESTED',$7,$7)`,
      [refund.id, refund.bookingId, refund.userId, refund.organizationId, refund.amountInr, refund.reason, now]
    );
    await client.query("COMMIT");
    return refund;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listRefundRequests(filters?: {
  organizationId?: string;
  userId?: string;
}): Promise<RefundRequest[]> {
  const pool = getPool();
  if (!pool) {
    let list = getMemoryStore().refunds.slice();
    if (filters?.organizationId) list = list.filter((r) => r.organizationId === filters.organizationId);
    if (filters?.userId) list = list.filter((r) => r.userId === filters.userId);
    return list;
  }

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters?.organizationId) {
    params.push(filters.organizationId);
    clauses.push(`organization_id = $${params.length}`);
  }
  if (filters?.userId) {
    params.push(filters.userId);
    clauses.push(`user_id = $${params.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const res = await pool.query(`SELECT * FROM refund_requests ${where} ORDER BY created_at DESC`, params);
  return res.rows.map((r) => ({
    id: String(r.id),
    bookingId: String(r.booking_id),
    userId: r.user_id ? String(r.user_id) : null,
    organizationId: r.organization_id ? String(r.organization_id) : null,
    amountInr: Number(r.amount_inr),
    reason: String(r.reason),
    status: r.status as RefundRequest["status"],
    reviewedBy: r.reviewed_by ? String(r.reviewed_by) : null,
    resolutionNote: r.resolution_note ? String(r.resolution_note) : null,
    createdAt: new Date(String(r.created_at)).toISOString(),
    updatedAt: new Date(String(r.updated_at)).toISOString()
  }));
}

export async function decideRefundRequest(
  refundId: string,
  rawInput: unknown,
  actor: { id: string; email: string | null; role: string }
): Promise<RefundRequest> {
  const input = decideRefundSchema.parse(rawInput);
  const now = new Date().toISOString();

  const pool = getPool();
  if (!pool) {
    const store = getMemoryStore();
    const refund = store.refunds.find((r) => r.id === refundId);
    if (!refund) throw new Error("Refund request not found.");
    if (!canTransitionRefundStatus(refund.status, input.status)) {
      throw new Error(`Invalid refund transition from ${refund.status} to ${input.status}.`);
    }
    const before = { ...refund };
    refund.status = input.status;
    refund.reviewedBy = actor.id;
    refund.resolutionNote = input.resolutionNote ?? null;
    refund.updatedAt = now;

    const booking = store.bookings.find((b) => b.id === refund.bookingId);
    if (booking) {
      if (input.status === "PROCESSED") {
        booking.status = "REFUNDED";
        booking.paymentStatus = "REFUNDED";
        for (const t of store.tickets) {
          if (t.bookingId === booking.id && t.status === "VALID") t.status = "CANCELLED";
        }
        const evt = store.events.find((e) => e.id === booking.eventId);
        if (evt) {
          for (const item of booking.items) {
            const tier = evt.tiers.find((t) => t.id === item.tierId);
            if (tier) tier.remainingQuota += item.quantity;
          }
        }
        store.ledger.unshift({
          id: `led_${crypto.randomUUID().slice(0, 10)}`,
          organizationId: refund.organizationId,
          bookingId: refund.bookingId,
          refundId: refund.id,
          settlementId: null,
          entryType: "REFUND_DEBIT",
          amountInr: -refund.amountInr,
          currency: "INR",
          mode: "DEMO_LEDGER",
          note: `Demo refund processed for ${booking.referenceCode}`,
          createdAt: now
        });
      } else if (input.status === "REJECTED") {
        booking.status = "CONFIRMED_DEMO";
      }
    }
    await recordAuditLog({
      actorUserId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      action: `REFUND_${input.status}`,
      targetType: "refund_request",
      targetId: refund.id,
      beforeJson: before,
      afterJson: refund
    });
    return refund;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rRes = await client.query("SELECT * FROM refund_requests WHERE id = $1 FOR UPDATE", [refundId]);
    if (rRes.rowCount === 0) throw new Error("Refund request not found.");
    const row = rRes.rows[0];
    const currentStatus = String(row.status) as RefundRequest["status"];
    if (!canTransitionRefundStatus(currentStatus, input.status)) {
      throw new Error(`Invalid refund transition from ${currentStatus} to ${input.status}.`);
    }
    const upd = await client.query(
      `UPDATE refund_requests SET status = $2, reviewed_by = $3, resolution_note = $4, updated_at = $5
       WHERE id = $1 RETURNING *`,
      [refundId, input.status, actor.id, input.resolutionNote ?? null, now]
    );
    const bookingId = String(row.booking_id);
    if (input.status === "PROCESSED") {
      await client.query(
        "UPDATE bookings SET status = 'REFUNDED', payment_status = 'REFUNDED' WHERE id = $1",
        [bookingId]
      );
      await client.query(
        "UPDATE tickets SET status = 'CANCELLED' WHERE booking_id = $1 AND status = 'VALID'",
        [bookingId]
      );
      const itemRes = await client.query("SELECT tier_id, quantity FROM booking_items WHERE booking_id = $1", [bookingId]);
      for (const item of itemRes.rows) {
        await client.query(
          "UPDATE ticket_tiers SET remaining_quota = remaining_quota + $1 WHERE id = $2",
          [Number(item.quantity), String(item.tier_id)]
        );
      }
      await client.query(
        `INSERT INTO ledger_entries (id, organization_id, booking_id, refund_id, entry_type, amount_inr, note)
         VALUES ($1,$2,$3,$4,'REFUND_DEBIT',$5,$6)`,
        [
          `led_${crypto.randomUUID().slice(0, 10)}`,
          row.organization_id ? String(row.organization_id) : null,
          bookingId,
          refundId,
          -Number(row.amount_inr),
          `Demo refund processed (${refundId})`
        ]
      );
    } else if (input.status === "REJECTED") {
      await client.query("UPDATE bookings SET status = 'CONFIRMED_DEMO' WHERE id = $1", [bookingId]);
    }
    await client.query("COMMIT");

    const updated = upd.rows[0];
    const result: RefundRequest = {
      id: String(updated.id),
      bookingId: String(updated.booking_id),
      userId: updated.user_id ? String(updated.user_id) : null,
      organizationId: updated.organization_id ? String(updated.organization_id) : null,
      amountInr: Number(updated.amount_inr),
      reason: String(updated.reason),
      status: updated.status as RefundRequest["status"],
      reviewedBy: updated.reviewed_by ? String(updated.reviewed_by) : null,
      resolutionNote: updated.resolution_note ? String(updated.resolution_note) : null,
      createdAt: new Date(String(updated.created_at)).toISOString(),
      updatedAt: new Date(String(updated.updated_at)).toISOString()
    };
    await recordAuditLog({
      actorUserId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      action: `REFUND_${input.status}`,
      targetType: "refund_request",
      targetId: refundId,
      beforeJson: { status: currentStatus },
      afterJson: result
    });
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listSavedItems(userId: string): Promise<SavedItem[]> {
  const pool = getPool();
  if (!pool) {
    return getMemoryStore().savedItems.filter((s) => s.userId === userId);
  }
  const res = await pool.query("SELECT * FROM saved_items WHERE user_id = $1 ORDER BY created_at DESC", [userId]);
  return res.rows.map((r) => ({
    id: String(r.id),
    userId: String(r.user_id),
    itemType: r.item_type as SavedItem["itemType"],
    itemSlug: String(r.item_slug),
    createdAt: new Date(String(r.created_at)).toISOString()
  }));
}

export async function toggleSavedItem(
  userId: string,
  itemType: SavedItem["itemType"],
  itemSlug: string
): Promise<{ saved: boolean; items: SavedItem[] }> {
  const pool = getPool();
  if (!pool) {
    const store = getMemoryStore();
    const idx = store.savedItems.findIndex(
      (s) => s.userId === userId && s.itemType === itemType && s.itemSlug === itemSlug
    );
    if (idx >= 0) {
      store.savedItems.splice(idx, 1);
      return { saved: false, items: await listSavedItems(userId) };
    }
    store.savedItems.unshift({
      id: `sav_${crypto.randomUUID().slice(0, 10)}`,
      userId,
      itemType,
      itemSlug,
      createdAt: new Date().toISOString()
    });
    return { saved: true, items: await listSavedItems(userId) };
  }

  const existing = await pool.query(
    "SELECT id FROM saved_items WHERE user_id = $1 AND item_type = $2 AND item_slug = $3",
    [userId, itemType, itemSlug]
  );
  if ((existing.rowCount ?? 0) > 0) {
    await pool.query("DELETE FROM saved_items WHERE id = $1", [String(existing.rows[0].id)]);
    return { saved: false, items: await listSavedItems(userId) };
  }
  await pool.query(
    `INSERT INTO saved_items (id, user_id, item_type, item_slug) VALUES ($1,$2,$3,$4)`,
    [`sav_${crypto.randomUUID().slice(0, 10)}`, userId, itemType, itemSlug]
  );
  return { saved: true, items: await listSavedItems(userId) };
}

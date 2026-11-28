import Link from "next/link";
import { DISCOVERY_CATEGORIES, formatInr } from "@nightlifez/shared";
import { AppHeader } from "@/components/AppHeader";
import {
  ArtistCard,
  CollectionCard,
  EmptyState,
  SectionHeader,
  VenueCard
} from "@/components/DiscoveryCards";
import { EventCard } from "@/components/EventCard";
import { HeroCarousel } from "@/components/HeroCarousel";
import {
  listArtists,
  listCitiesAndEvents,
  listCollections,
  listVenues
} from "@/lib/repository";

export const dynamic = "force-dynamic";

function categoryHref(key: string, city: string) {
  const params = new URLSearchParams();
  if (city !== "all") params.set("city", city);
  params.set("category", key);
  return `/events?${params.toString()}`;
}

export default async function HomePage({
  searchParams
}: {
  searchParams: Promise<{ city?: string }>;
}) {
  const sp = await searchParams;
  const city = sp.city ?? "all";

  const [{ cities, events }, artists, venues, collections] = await Promise.all([
    listCitiesAndEvents({ city }),
    listArtists(city),
    listVenues(city),
    listCollections()
  ]);

  const activeCityName =
    city === "all" ? "Your City" : cities.find((c) => c.slug === city)?.name ?? city;

  const featured = events.filter((e) => e.isFeatured);
  const featuredIds = new Set(featured.map((e) => e.id));
  const nonFeatured = events.filter((e) => !featuredIds.has(e.id));
  const trending = nonFeatured.length > 0 ? nonFeatured : events.slice().reverse();
  const weekendEvents = events.filter((e) => {
    const day = new Date(e.startsAt).getUTCDay();
    return day === 0 || day === 6 || day === 5;
  });

  const allOffers = events.flatMap((e) =>
    e.offers.map((o) => ({ offer: o, eventTitle: e.title, eventSlug: e.slug }))
  );

  return (
    <div className="min-h-screen pb-14">
      <AppHeader cities={cities} selectedCity={city} />

      <main className="mx-auto max-w-7xl space-y-10 px-3 py-6 sm:px-6">
        {/* 1. Featured Hero Carousel */}
        {events.length > 0 ? (
          <HeroCarousel events={featured.length > 0 ? featured : events} />
        ) : null}

        {/* 2. Featured Experiences */}
        <section>
          <SectionHeader
            title="Featured Experiences"
            subtitle="Handpicked concerts, festivals & live showcases"
            actionHref={city === "all" ? "/events" : `/events?city=${encodeURIComponent(city)}`}
          />
          {events.length === 0 ? (
            <EmptyState
              title="No featured events in this city yet"
              description="Switch to All Cities to explore live events across India."
              actionHref="/"
              actionLabel="Show All Cities"
            />
          ) : (
            <div className="flex gap-4 overflow-x-auto pb-2">
              {(featured.length > 0 ? featured : events).map((evt) => (
                <EventCard key={evt.id} event={evt} compact />
              ))}
            </div>
          )}
        </section>

        {/* 3. Artist Discovery */}
        <section>
          <SectionHeader
            title="Artists on Tour"
            subtitle="Follow live performers & upcoming sets"
            actionHref="/events"
          />
          <div className="flex gap-3.5 overflow-x-auto pb-2">
            {artists.map((artist) => (
              <ArtistCard key={artist.slug} artist={artist} />
            ))}
          </div>
        </section>

        {/* 4. Trending Near Your City */}
        <section>
          <SectionHeader
            title={`Trending in ${activeCityName}`}
            subtitle="Fast-filling rooms, comedy nights & skyline sets"
            actionHref={city === "all" ? "/events" : `/events?city=${encodeURIComponent(city)}`}
          />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {trending.slice(0, 3).map((evt) => (
              <EventCard key={evt.id} event={evt} />
            ))}
          </div>
        </section>

        {/* 5. This Weekend */}
        <section>
          <SectionHeader
            title="This Weekend"
            subtitle="Curated Friday–Sunday picks"
            actionHref="/events?dateWindow=weekend"
          />
          <div className="flex gap-4 overflow-x-auto pb-2">
            {(weekendEvents.length > 0 ? weekendEvents : events).map((evt) => (
              <EventCard key={`wknd-${evt.id}`} event={evt} compact />
            ))}
          </div>
        </section>

        {/* 6. Discover by Category */}
        <section>
          <SectionHeader
            title="Discover by Category"
            subtitle="Jump straight into what you feel like doing tonight"
          />
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
            {DISCOVERY_CATEGORIES.map((cat) => (
              <Link
                key={cat.key}
                href={categoryHref(cat.key, city)}
                className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-[#e4e6f0] bg-white p-3.5 text-center transition hover:-translate-y-0.5 hover:border-[#5b3df5] hover:shadow-sm"
              >
                <span
                  className="flex h-10 w-10 items-center justify-center rounded-xl text-sm font-extrabold text-white"
                  style={{ backgroundColor: cat.color }}
                >
                  {cat.label.slice(0, 2).toUpperCase()}
                </span>
                <span className="text-xs font-bold text-[#111319]">{cat.label}</span>
              </Link>
            ))}
          </div>
        </section>

        {/* 7. Popular Venues */}
        <section>
          <SectionHeader
            title="Popular Venues"
            subtitle="Explore seating zones, timings & facilities"
          />
          <div className="flex gap-4 overflow-x-auto pb-2">
            {venues.map((venue) => (
              <VenueCard key={venue.slug} venue={venue} />
            ))}
          </div>
        </section>

        {/* 8. Offers & Deals */}
        {allOffers.length > 0 ? (
          <section>
            <SectionHeader
              title="Offers & Promo Deals"
              subtitle="Instant savings applied at checkout"
            />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {allOffers.slice(0, 6).map(({ offer, eventTitle, eventSlug }) => (
                <Link
                  key={offer.id}
                  href={`/events/${eventSlug}`}
                  className="flex flex-col justify-between rounded-2xl border border-[#e4e6f0] bg-white p-4 transition hover:border-[#5b3df5]"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="rounded-full bg-[#efeafe] px-2.5 py-0.5 text-[11px] font-extrabold text-[#5b3df5]">
                        CODE: {offer.code}
                      </span>
                      <span className="text-[11px] font-medium text-[#5e6473]">
                        Min {formatInr(offer.minOrderInr)}
                      </span>
                    </div>
                    <h3 className="mt-2.5 text-sm font-extrabold text-[#111319]">{offer.title}</h3>
                    <p className="mt-1 text-xs text-[#5e6473]">{offer.description}</p>
                  </div>
                  <div className="mt-3 border-t border-[#e4e6f0] pt-2 text-[11px] font-semibold text-[#5b3df5]">
                    {eventTitle} →
                  </div>
                </Link>
              ))}
            </div>
          </section>
        ) : null}

        {/* 9. Editorial Collections */}
        <section>
          <SectionHeader
            title="Editorial Collections"
            subtitle="Curated guides for every mood"
          />
          <div className="flex gap-4 overflow-x-auto pb-2">
            {collections.map((col) => (
              <CollectionCard key={col.id} collection={col} />
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

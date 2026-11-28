import Link from "next/link";
import { notFound } from "next/navigation";
import { formatInr, getMinTierPrice } from "@nightlifez/shared";
import { AppHeader } from "@/components/AppHeader";
import { SaveItemButton } from "@/components/SaveItemButton";
import { getEventDetail, listCitiesAndEvents } from "@/lib/repository";

export const dynamic = "force-dynamic";

export default async function EventDetailPage({
  params
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const [detail, list] = await Promise.all([getEventDetail(slug), listCitiesAndEvents()]);
  if (!detail) notFound();

  const { event, venue } = detail;
  const minPrice = getMinTierPrice(event.tiers);
  const topOffer = event.offers[0];

  return (
    <div className="min-h-screen pb-32 lg:pb-14">
      <AppHeader cities={list.cities} selectedCity={event.citySlug} />

      <main className="mx-auto max-w-6xl space-y-6 px-3 py-5 sm:px-6">
        {/* Hero Media Banner */}
        <section className="relative overflow-hidden rounded-3xl border border-[#e4e6f0] bg-[#111319] text-white shadow-lg">
          <div className="grid lg:grid-cols-12">
            <div className="relative aspect-[16/9] w-full overflow-hidden lg:col-span-7 lg:aspect-auto lg:min-h-[340px]">
              <img
                src={event.artworkUrl ?? "/art/evt-solstice.svg"}
                alt={event.title}
                className="h-full w-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-[#111319]/90 via-transparent to-transparent lg:bg-gradient-to-r lg:from-transparent lg:to-[#111319]" />
            </div>

            <div className="flex flex-col justify-between gap-4 p-5 sm:p-8 lg:col-span-5">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold">
                  <span className="rounded-full bg-[#5b3df5] px-3 py-1 uppercase">
                    {event.category}
                  </span>
                  <span className="rounded-full bg-white/15 px-3 py-1">
                    {event.activePhase.replace("_", " ")}
                  </span>
                  {event.ageLimit ? (
                    <span className="rounded-full bg-white/10 px-3 py-1">{event.ageLimit}</span>
                  ) : null}
                </div>

                <h1 className="text-2xl font-extrabold leading-tight sm:text-3xl">{event.title}</h1>
                <p className="text-sm font-bold text-[#c4b5fd]">{event.dateLabel}</p>

                <div className="space-y-1 text-xs text-white/80 sm:text-sm">
                  <p>
                    {event.venueName}
                    {event.distanceKm ? ` · ${event.distanceKm} km away` : ""}
                  </p>
                  <p>
                    {event.language ? `${event.language}` : ""}
                    {event.durationLabel ? ` · ${event.durationLabel}` : ""}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-2">
                <Link
                  href={`/venues/${event.venueSlug}`}
                  className="rounded-full border border-white/25 px-4 py-2 text-xs font-bold text-white hover:bg-white/10"
                >
                  View Venue Guide →
                </Link>
                <SaveItemButton itemType="event" itemSlug={event.slug} />
              </div>
            </div>
          </div>
        </section>

        <div className="grid gap-6 lg:grid-cols-12">
          {/* Primary Details Column */}
          <div className="space-y-6 lg:col-span-8">
            <section className="rounded-2xl border border-[#e4e6f0] bg-white p-5 sm:p-6">
              <h2 className="text-lg font-extrabold text-[#111319]">About the Event</h2>
              <p className="mt-2 text-sm leading-relaxed text-[#5e6473]">{event.summary}</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {event.highlights.map((h) => (
                  <div key={h.title} className="rounded-xl bg-[#f6f7fb] p-3.5">
                    <h3 className="text-xs font-extrabold uppercase tracking-wide text-[#5b3df5]">
                      {h.title}
                    </h3>
                    <p className="mt-1 text-xs text-[#111319]">{h.body}</p>
                  </div>
                ))}
              </div>
            </section>

            {/* Artist Lineup */}
            <section className="rounded-2xl border border-[#e4e6f0] bg-white p-5 sm:p-6">
              <h2 className="text-lg font-extrabold text-[#111319]">Artist Lineup</h2>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                {event.lineup.map((artist) => {
                  const cardContent = (
                    <div className="flex items-center gap-3 rounded-2xl border border-[#e4e6f0] bg-[#f6f7fb] p-3 transition hover:border-[#5b3df5]">
                      {artist.artworkUrl ? (
                        <img
                          src={artist.artworkUrl}
                          alt={artist.name}
                          className="h-12 w-12 shrink-0 rounded-full object-cover"
                        />
                      ) : null}
                      <div className="min-w-0">
                        <div className="truncate text-sm font-bold text-[#111319]">{artist.name}</div>
                        <div className="truncate text-xs text-[#5e6473]">{artist.role}</div>
                      </div>
                    </div>
                  );
                  return artist.slug ? (
                    <Link key={artist.name} href={`/artists/${artist.slug}`}>
                      {cardContent}
                    </Link>
                  ) : (
                    <div key={artist.name}>{cardContent}</div>
                  );
                })}
              </div>
            </section>

            {/* Sales Timeline */}
            <section className="rounded-2xl border border-[#e4e6f0] bg-white p-5 sm:p-6">
              <h2 className="text-lg font-extrabold text-[#111319]">Ticket Sales Timeline</h2>
              <ol className="mt-4 space-y-2.5">
                {event.salesTimeline.map((step) => (
                  <li
                    key={step.label}
                    className="flex items-center justify-between rounded-xl border border-[#e4e6f0] px-4 py-3 text-sm"
                  >
                    <div>
                      <div className="font-bold text-[#111319]">{step.label}</div>
                      <div className="text-[11px] text-[#5e6473]">
                        {new Date(step.startsAt).toLocaleDateString("en-IN", {
                          day: "numeric",
                          month: "short",
                          year: "numeric"
                        })}
                      </div>
                    </div>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase ${
                        step.state === "active"
                          ? "bg-[#dcfce7] text-[#16a34a]"
                          : step.state === "completed"
                          ? "bg-[#f3f4f6] text-[#5e6473]"
                          : "bg-[#f3e8ff] text-[#7c3aed]"
                      }`}
                    >
                      {step.state}
                    </span>
                  </li>
                ))}
              </ol>
            </section>

            {/* Venue Card */}
            {venue ? (
              <section className="rounded-2xl border border-[#e4e6f0] bg-white p-5 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-lg font-extrabold text-[#111319]">Venue</h2>
                  <Link
                    href={`/venues/${venue.slug}`}
                    className="text-xs font-bold text-[#5b3df5] underline"
                  >
                    Full Venue Guide →
                  </Link>
                </div>
                <p className="mt-2 text-sm font-bold text-[#111319]">{venue.name}</p>
                <p className="mt-0.5 text-xs text-[#5e6473]">{venue.address}</p>
                <p className="mt-2 text-xs text-[#5e6473]">{venue.summary}</p>
              </section>
            ) : null}

            {/* Facilities & Policies */}
            <section className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-[#e4e6f0] bg-white p-5">
                <h2 className="text-base font-extrabold text-[#111319]">Facilities at the Event</h2>
                <ul className="mt-3 space-y-1.5 text-xs text-[#5e6473] sm:text-sm">
                  {event.facilities.map((f) => (
                    <li key={f}>• {f}</li>
                  ))}
                </ul>
              </div>
              <div className="rounded-2xl border border-[#e4e6f0] bg-white p-5">
                <h2 className="text-base font-extrabold text-[#111319]">Event Policies & Entry</h2>
                <ul className="mt-3 space-y-1.5 text-xs text-[#5e6473] sm:text-sm">
                  {event.policies.map((p) => (
                    <li key={p}>• {p}</li>
                  ))}
                </ul>
              </div>
            </section>
          </div>

          {/* Sticky Desktop Booking & Offers Sidebar */}
          <aside className="space-y-4 lg:col-span-4">
            <div className="sticky top-28 space-y-4">
              <div className="rounded-2xl border border-[#e4e6f0] bg-white p-5 shadow-sm">
                <div className="text-xs font-bold uppercase tracking-wide text-[#5e6473]">
                  Tickets starting from
                </div>
                <div className="mt-1 text-2xl font-extrabold text-[#111319]">
                  {formatInr(minPrice)}{" "}
                  <span className="text-sm font-normal text-[#5e6473]">onwards</span>
                </div>
                {event.partialReservePercent ? (
                  <p className="mt-2.5 rounded-xl bg-[#f3e8ff] px-3 py-2 text-xs font-bold text-[#7c3aed]">
                    Pay {event.partialReservePercent}% demo deposit option supported
                  </p>
                ) : null}
                <Link
                  href={`/events/${event.slug}/book`}
                  className="mt-4 block w-full rounded-xl bg-[#111319] py-3.5 text-center text-sm font-bold text-white transition hover:bg-[#5b3df5]"
                >
                  Book tickets
                </Link>
                <p className="mt-2 text-center text-[11px] text-[#5e6473]">
                  {process.env.VERCEL_ENV === "production"
                    ? "Organiser-managed availability"
                    : "Demo mode · Server-authoritative inventory"}
                </p>
              </div>

              <div className="rounded-2xl border border-[#e4e6f0] bg-white p-5">
                <h2 className="text-base font-extrabold text-[#111319]">Available Offers</h2>
                {event.offers.length === 0 ? (
                  <p className="mt-2 text-xs text-[#5e6473]">
                    No promo codes active for this event right now.
                  </p>
                ) : (
                  <div className="mt-3 space-y-2.5">
                    {event.offers.map((offer) => (
                      <div
                        key={offer.id}
                        className="rounded-xl border border-[#e4e6f0] bg-[#efeafe]/60 p-3 text-xs"
                      >
                        <div className="flex items-center justify-between gap-2 font-extrabold text-[#5b3df5]">
                          <span>{offer.title}</span>
                          <span className="rounded bg-white px-2 py-0.5 text-[10px]">
                            {offer.code}
                          </span>
                        </div>
                        <p className="mt-1 text-[#5e6473]">{offer.description}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-[#e4e6f0] bg-white p-5 text-sm">
                <div className="text-xs font-bold uppercase text-[#5e6473]">Organized by</div>
                <div className="mt-1 font-extrabold text-[#111319]">{event.organizerName}</div>
                <div className="mt-1 text-xs text-[#5e6473]">
                  {event.organizerRating}% liked · {event.organizerTenure}
                </div>
              </div>
            </div>
          </aside>
        </div>
      </main>

      {/* Mobile Sticky Bottom Booking Bar */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-[#e4e6f0] bg-white p-3 shadow-2xl lg:hidden">
        {topOffer ? (
          <div className="mb-2 rounded-lg bg-[#efeafe] px-3 py-1.5 text-xs font-bold text-[#5b3df5]">
            {topOffer.title} · Code {topOffer.code}
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-base font-extrabold text-[#111319]">
              {formatInr(minPrice)} onwards
            </div>
            <div className="text-[11px] text-[#5e6473]">
              {event.offers.length} {event.offers.length === 1 ? "offer" : "offers"} available
            </div>
          </div>
          <Link
            href={`/events/${event.slug}/book`}
            className="rounded-full bg-[#111319] px-6 py-2.5 text-sm font-bold text-white"
          >
            Book tickets
          </Link>
        </div>
      </div>
    </div>
  );
}

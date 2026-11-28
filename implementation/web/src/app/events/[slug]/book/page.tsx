import Link from "next/link";
import { notFound } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { BookingFlow } from "@/components/BookingFlow";
import { getEventDetail, listCitiesAndEvents } from "@/lib/repository";

export const dynamic = "force-dynamic";

export default async function BookEventPage({
  params
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const [detail, list] = await Promise.all([getEventDetail(slug), listCitiesAndEvents()]);
  if (!detail) notFound();

  return (
    <div className="min-h-screen">
      <AppHeader cities={list.cities} selectedCity={detail.event.citySlug} />

      <main className="mx-auto max-w-6xl space-y-5 px-3 py-6 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <Link
              href={`/events/${detail.event.slug}`}
              className="text-xs font-semibold text-[#5b3df5]"
            >
              ← Back to Event Details
            </Link>
            <h1 className="mt-1 text-xl font-extrabold text-[#111319] sm:text-2xl">
              {detail.event.title}
            </h1>
            <p className="text-xs text-[#5e6473]">
              {detail.event.dateLabel} · {detail.event.venueName}
            </p>
          </div>
        </div>

        <BookingFlow
          event={detail.event}
          venue={detail.venue}
          productionMode={process.env.VERCEL_ENV === "production"}
        />
      </main>
    </div>
  );
}

"use client";

import dynamic from "next/dynamic";

const DottedMap = dynamic(() => import("./DottedMap"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[560px] bg-[var(--ds-background-100)] animate-pulse rounded-md" />
  ),
});

export default function MapContainer() {
  return <DottedMap />;
}

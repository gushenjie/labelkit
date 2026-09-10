import { notFound } from "next/navigation";
import { InteractionSamples } from "./samples";

export default function UxSamplesPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <InteractionSamples />;
}

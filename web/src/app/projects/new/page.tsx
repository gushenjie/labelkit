import { redirect } from "next/navigation";

export default function NewProjectPage() {
  redirect("/?create=1");
}

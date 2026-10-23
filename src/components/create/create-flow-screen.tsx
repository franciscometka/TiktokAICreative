"use client";

import { useRouter } from "next/navigation";
import { startVideoV2Action } from "@/app/actions";
import { CreateFlow, type CreateFlowProps } from "./create-flow";

/** Liga o Create de 4 passos à MESMA Server Action do Create antigo e à navegação para o projeto. */
export function CreateFlowScreen(props: Omit<CreateFlowProps, "submit" | "onCreated" | "Uploader">) {
  const router = useRouter();
  return <CreateFlow {...props} submit={startVideoV2Action} onCreated={(id) => router.push(`/campaigns/${id}`)} />;
}

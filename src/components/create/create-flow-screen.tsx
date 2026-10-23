"use client";

import { useRouter } from "next/navigation";
import { startVideoV2Action } from "@/app/actions";
import { useOptionalToast } from "../ds";
import { CreateFlow, type CreateFlowProps } from "./create-flow";

/** Liga o Create de 4 passos à MESMA Server Action do Create antigo e à navegação para o projeto. */
export function CreateFlowScreen(props: Omit<CreateFlowProps, "submit" | "onCreated" | "Uploader">) {
  const router = useRouter();
  const toast = useOptionalToast();
  return <CreateFlow {...props} submit={startVideoV2Action} onCreated={(id) => {
    // L8.8: criar não autoriza gasto — o toast lembra que a geração espera a aprovação.
    toast.show({ id: `project:${id}:created`, title: "Projeto criado", description: "Revise a estimativa e aprove para gerar o vídeo.", tone: "success" });
    router.push(`/campaigns/${id}`);
  }} />;
}

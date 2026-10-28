"use client";

import { useRouter } from "next/navigation";
import { startVideoV2Action } from "@/app/actions";
import { ImageUploader } from "../create/image-uploader";
import { CreateVideoForm, type CreateVideoFormProps } from "./create-video-form";

/** Liga o formulário V2 à Server Action e à navegação. */
export function CreateVideo(props: Omit<CreateVideoFormProps, "Uploader" | "submit" | "onCreated">) {
  const router = useRouter();
  return <CreateVideoForm {...props} Uploader={ImageUploader} submit={startVideoV2Action} onCreated={(id) => router.push(`/campaigns/${id}`)} />;
}

"use client";

import { useFormStatus } from "react-dom";

import { Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";

/** A form's submit button: shows the spinner in place of its label while the action runs. */
export function SubmitButton({ children, className }: { children: React.ReactNode; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={cn("btn btn-primary", className)}>
      {pending ? <Spinner size="1rem" color="currentColor" /> : children}
    </button>
  );
}

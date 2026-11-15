// Variable that lets a page warn before in-app navigation when it holds unsaved work
let unsavedMessage: string | null = null;

export function setUnsavedMessage(message: string | null) {
  unsavedMessage = message;
}

// True when it is fine to leave: nothing unsaved, or the user confirmed
export function confirmLeave(): boolean {
  return !unsavedMessage || window.confirm(unsavedMessage);
}
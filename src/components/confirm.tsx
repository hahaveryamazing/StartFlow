import { createContext, useContext, useState, type ReactNode } from 'react';
import { Modal } from './ui/dialog';
import { Button } from './ui/button';
type Request = { title: string; description: string; resolve: (answer: boolean) => void };
const Context = createContext<(title: string, description: string) => Promise<boolean>>(() =>
  Promise.resolve(false),
);
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null);
  const ask = (title: string, description: string) =>
    new Promise<boolean>((resolve) => setRequest({ title, description, resolve }));
  const finish = (answer: boolean) => {
    request?.resolve(answer);
    setRequest(null);
  };
  return (
    <Context.Provider value={ask}>
      {children}
      {request && (
        <Modal
          title={request.title}
          description={request.description}
          open
          onClose={() => finish(false)}
        >
          <div className="modal-footer">
            <Button variant="secondary" onClick={() => finish(false)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => finish(true)}>
              确认继续
            </Button>
          </div>
        </Modal>
      )}
    </Context.Provider>
  );
}
export const useConfirm = () => useContext(Context);

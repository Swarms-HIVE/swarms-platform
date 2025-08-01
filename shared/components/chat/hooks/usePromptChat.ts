'use client';

import React, { useEffect, useRef, useState } from 'react';
import { trpc } from '@/shared/utils/trpc/trpc';
import { Tables } from '@/types_db';
import { v4 as uuidv4 } from 'uuid';
import { useOnClickOutside } from '@/shared/hooks/onclick-outside';
import { useToast } from '@/shared/components/ui/Toasts/use-toast';
import { ChatComponentProps } from '../prompt';
import { useAuthContext } from '@/shared/components/ui/auth.provider';

export default function usePromptChat({
  promptId,
  systemPrompt,
  model = 'gpt-4',
}: ChatComponentProps) {
  const { user } = useAuthContext();
  const [input, setInput] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  const [messages, setMessages] = useState<
    Tables<'swarms_cloud_prompts_chat'>[]
  >([]);
  const toast = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [streamedResponse, setStreamedResponse] = useState('');
  const [editingMessageId, setEditingMessageId] = useState('');
  const [editInput, setEditInput] = useState('');
  const [abortReader, setAbortReader] =
    useState<ReadableStreamDefaultReader | null>(null);
  const [usedTokens, setUsedTokens] = useState(0);

  const [isStreaming, setIsStreaming] = useState(false);

  const latestMessageRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const fetchMessages = trpc.explorer.getPromptChats.useQuery(
    { promptId },
    { enabled: false, refetchOnWindowFocus: false },
  );
  const fetchMutation = trpc.explorer.savePromptChat.useMutation();
  const editMutation = trpc.explorer.editPromptChat.useMutation();
  const deductCredit = trpc.explorer.deductCredit.useMutation();
  const deleteMutation = trpc.explorer.deletePromptChat.useMutation();

  const messageId = uuidv4();

  const handleInputBlur = () => {
    setEditInput('');
    setEditingMessageId('');
  };

  useOnClickOutside(textareaRef, handleInputBlur);

  useEffect(() => {
    if (streamedResponse) {
      if (!editingMessageId) {
        setMessages((prev) =>
          prev.map((m, index) =>
            index === prev.length - 1 ? { ...m, text: streamedResponse } : m,
          ),
        );
      } else {
        setMessages((prev) =>
          prev.map((m) =>
            m.response_id === `${editingMessageId}_agent`
              ? { ...m, text: streamedResponse }
              : m,
          ),
        );
      }
    }
  }, [streamedResponse, editingMessageId]);

  useEffect(() => {
    if (user && fetchMessages.data === undefined && !fetchMessages.isFetching) {
      fetchMessages.refetch().then(({ data }) => {
        if (data) setMessages(data);
      });
    }
  }, [fetchMessages.data, user]);

  const prevMessagesLength = useRef(0);
  const isInitialLoad = useRef(true);
  const hasUserInteracted = useRef(false);

  useEffect(() => {
    if (
      !isInitialLoad.current &&
      hasUserInteracted.current &&
      latestMessageRef.current &&
      messages.length > prevMessagesLength.current
    ) {
      latestMessageRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }

    prevMessagesLength.current = messages.length;

    if (isInitialLoad.current && messages.length >= 0) {
      isInitialLoad.current = false;
    }
  }, [messages]);

  const handleSend = async () => {
    if (!user) {
      toast.toast({
        description: 'Log in to perform this action',
        style: { color: 'red' },
      });
      return;
    }

    if (!input.trim() || isLoading) return;
    setIsLoading(true);
    setIsStreaming(true);

    hasUserInteracted.current = true;

    const newUserMessage = {
      text: input,
      sender: 'user',
      prompt_id: promptId,
      user_id: user?.id,
      response_id: `${messageId}`,
    } as Tables<'swarms_cloud_prompts_chat'>;

    setMessages((prev) => [...prev, newUserMessage]);

    const aiResponse = {
      text: '',
      sender: 'agent',
      prompt_id: promptId,
      user_id: user?.id,
      response_id: `${messageId}_agent`,
    } as Tables<'swarms_cloud_prompts_chat'>;

    setMessages((prev) => [...prev, aiResponse]);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: input,
          systemPrompt,
          userId: user?.id,
          promptId,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        toast.toast({
          title: errorData.error || 'An error has occurred',
          variant: 'destructive',
        });
        return;
      }

      const reader = response.body?.getReader();
      setAbortReader(reader ?? null);

      const decoder = new TextDecoder();
      let completeText = '';

      while (reader) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        completeText += chunk;

        setStreamedResponse(completeText);
      }

      const headerToken = Number(response.headers.get('X-Used-Tokens')) || 0;
      setUsedTokens(headerToken);

      if (headerToken) {
        deductCredit.mutateAsync({ amount: headerToken });
      }
      fetchMutation.mutateAsync([
        { ...newUserMessage },
        { ...aiResponse, text: completeText },
      ]);
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log('Streaming stopped by user.');
      } else {
        console.error('Error:', error);
        toast.toast({
          title:
            error?.error ||
            error ||
            error?.message ||
            'Error fetching response',
          variant: 'destructive',
        });
      }
    } finally {
      setIsLoading(false);
      setIsStreaming(false);
      setAbortReader(null);
      setInput('');
    }
  };

  const handleStop = async () => {
    if (abortReader) {
      abortReader.cancel();
      setIsStreaming(false);
      setAbortReader(null);

      if (usedTokens) {
        deductCredit.mutateAsync({ amount: usedTokens });
      }
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) =>
    setInput(e.target.value);

  const handleEditMessage = (responseId: string) => {
    setEditingMessageId(responseId);

    const messageToEdit = messages.find((m) => m.response_id === responseId);
    setEditInput(messageToEdit?.text || '');
  };

  const handleSendEdit = async (responseId: string) => {
    if (!user) {
      toast.toast({
        description: 'Log in to perform this action',
        style: { color: 'red' },
      });
      return;
    }

    if (!editInput.trim() || !responseId || isLoading) return;
    setIsLoading(true);
    setIsStreaming(true);

    setMessages((prev) =>
      prev.map((m) =>
        m.response_id === responseId ? { ...m, text: editInput } : m,
      ),
    );

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: editInput,
          systemPrompt,
          userId: user?.id,
          promptId,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        toast.toast({
          title: errorData.error || 'An error has occurred',
          variant: 'destructive',
        });
        return;
      }

      const reader = response.body?.getReader();
      setAbortReader(reader ?? null);

      const decoder = new TextDecoder();
      let completeText = '';

      while (reader) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        completeText += chunk;

        setStreamedResponse(completeText);
      }

      const headerToken = Number(response.headers.get('X-Used-Tokens')) || 0;
      setUsedTokens(headerToken);

      if (headerToken) {
        deductCredit.mutateAsync({ amount: headerToken });
      }

      editMutation.mutateAsync({
        promptId,
        responseId,
        userText: editInput,
        agentText: completeText,
      });
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log('Streaming stopped by user.');
      } else {
        console.error('Error editing message:', error);
        toast.toast({
          title:
            error?.error || error || error?.message || 'Error editing message',
          variant: 'destructive',
        });
      }
    } finally {
      setIsLoading(false);
      handleInputBlur();
      setIsStreaming(false);
      setAbortReader(null);
    }
  };

  const handleDeleteMessage = async (messageId: string) => {
    if (!user) {
      toast.toast({
        description: 'Log in to perform this action',
        style: { color: 'red' },
      });
      return;
    }

    setMessages((prev: any) => prev.filter((m: any) => m.id !== messageId));

    if (!messageId) return;
    await deleteMutation.mutateAsync({ messageId, promptId });
  };

  return {
    input,
    isExpanded,
    isLoading,
    editInput,
    messages,
    isStreaming,
    textareaRef,
    editingMessageId,
    latestMessageRef,
    handleSend,
    handleStop,
    setEditInput,
    setIsExpanded,
    handleSendEdit,
    handleInputBlur,
    handleEditMessage,
    handleInputChange,
    handleDeleteMessage,
  };
}

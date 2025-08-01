'use client';

import { useState, useEffect } from 'react';
import { useToast } from '@/shared/components/ui/Toasts/use-toast';
import { Button } from '@/shared/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/shared/components/ui/card';
import Modal from '@/shared/components/modal';
import {
  Wallet,
  CreditCard,
  AlertCircle,
  CheckCircle,
  Loader2,
  Download,
} from 'lucide-react';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { trpc } from '@/shared/utils/trpc/trpc';
import { useWallet } from './wallet-provider';
import { useConfig } from '@/shared/hooks/use-config';

import {
  calculateCommission,
  validateCommissionCalculation,
} from '@/shared/utils/marketplace/commission';
import {
  executeTransactionWithRetry,
  createEnhancedConnection,
} from '@/shared/utils/solana-transaction-utils';
import { launchConfetti } from '@/shared/utils/helpers';
import { getSolPrice } from '@/shared/services/sol-price';

interface PurchaseModalProps {
  isOpen: boolean;
  onClose: () => void;
  item: {
    id: string;
    name: string;
    price_usd?: number; // USD price from database (optional for safety)
    type: 'prompt' | 'agent';
    sellerWalletAddress: string;
    sellerId: string;
  };
  onPurchaseSuccess: () => void;
}

const PurchaseModal = ({
  isOpen,
  onClose,
  item,
  onPurchaseSuccess,
}: PurchaseModalProps) => {
  const { toast } = useToast();
  const { publicKey, isConnected, connect } = useWallet();
  const { rpcUrl, platformWalletAddress } = useConfig();
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [solPrice, setSolPrice] = useState<number | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      fetchSolPrice();
      setIsSuccess(false);
    }
  }, [isOpen]);

  const fetchSolPrice = async () => {
    try {
      setPriceError(null);
      const currentPrice = await getSolPrice();
      setSolPrice(currentPrice);
    } catch (error) {
      console.error('Failed to fetch SOL price:', error);
      setPriceError('Unable to fetch current SOL price. Please try again.');
      setSolPrice(null);
    }
  };
  const utils = trpc.useUtils();

  const createTransactionMutation =
    trpc.marketplace.createTransaction.useMutation({
      onSuccess: async () => {
        try {
          // Invalidate purchase check cache to immediately update access
          await utils.marketplace.checkUserPurchase.invalidate({
            itemId: item.id,
            itemType: item.type,
          });

          // Small delay to ensure database consistency
          await new Promise((resolve) => setTimeout(resolve, 500));

          await utils.marketplace.checkUserPurchase.refetch({
            itemId: item.id,
            itemType: item.type,
          });
        } catch (error) {
          console.warn('Cache invalidation failed:', error);
        }

        toast({
          description: 'Purchase completed successfully!',
          style: { backgroundColor: '#10B981', color: 'white' },
        });

        setIsSuccess(true);
        launchConfetti();

        setTimeout(() => {
          onPurchaseSuccess();
          onClose();
        }, 2000);
      },
      onError: (error) => {
        toast({
          description: error.message,
          variant: 'destructive',
        });
        setIsProcessing(false);
      },
    });

  const connectWallet = async () => {
    try {
      await connect();
    } catch (error: any) {
      console.error('Connect error:', error);

      let errorMessage =
        error?.message || 'Failed to connect wallet. Please try again.';

      if (errorMessage.includes('Phantom wallet not found')) {
        toast({
          description: (
            <div className="space-y-2">
              <p>{errorMessage}</p>
              <button
                onClick={() => window.open('https://phantom.com/', '_blank')}
                className="flex items-center gap-2 text-sm underline hover:no-underline"
              >
                <Download className="h-4 w-4" />
                Install Phantom Wallet
              </button>
            </div>
          ),
          variant: 'destructive',
          duration: 8000,
        });
      } else {
        toast({
          description: errorMessage,
          variant: 'destructive',
        });
      }
    }
  };

  const handlePurchase = async () => {
    if (!publicKey) {
      toast({
        description: 'Please connect your wallet first',
        variant: 'destructive',
      });
      return;
    }

    if (!solPrice) {
      toast({
        title: 'Price unavailable',
        description: 'Unable to get current SOL price. Please try again.',
        variant: 'destructive',
      });
      return;
    }

    setIsProcessing(true);

    try {
      // Convert USD to SOL at current market rate
      if (!item.price_usd || item.price_usd <= 0) {
        toast({
          title: 'Invalid price',
          description: 'Item price is not available',
          variant: 'destructive',
        });
        return;
      }

      const solAmount = item.price_usd / solPrice;

      const { solana } = window as any;
      if (!solana) {
        throw new Error('Phantom wallet not found');
      }

      if (!rpcUrl) {
        throw new Error('Solana RPC configuration missing');
      }

      if (!platformWalletAddress) {
        throw new Error('Platform wallet address not configured');
      }

      const connection = createEnhancedConnection(rpcUrl);

      const fromPubkey = new PublicKey(publicKey);
      const toPubkey = new PublicKey(item.sellerWalletAddress);
      const platformPubkey = new PublicKey(platformWalletAddress);

      const totalAmount = solAmount * LAMPORTS_PER_SOL;
      const commission = calculateCommission(solAmount);
      const platformFee = Math.floor(commission.platformFee * LAMPORTS_PER_SOL);
      const sellerAmount = totalAmount - platformFee;

      const result = await executeTransactionWithRetry({
        connection,
        fromPubkey,
        toPubkey,
        platformPubkey,
        sellerAmount,
        platformFee,
        solana,
      });

      if (!result.success) {
        throw new Error(result.error || 'Transaction failed');
      }

      await createTransactionMutation.mutateAsync({
        sellerId: item.sellerId,
        itemId: item.id,
        itemType: item.type,
        amount_usd: item.price_usd || 0, // USD amount from database
        amount_sol: solAmount, // SOL amount actually paid
        transactionSignature: result.signature,
        buyerWalletAddress: publicKey,
        sellerWalletAddress: item.sellerWalletAddress,
      });
    } catch (error) {
      console.error('Purchase error:', error);
      toast({
        title: 'Purchase Failed',
        description: error instanceof Error ? error.message : 'Purchase failed',
        variant: 'destructive',
      });
      setIsProcessing(false);
    }
  };

  const currentSolAmount =
    solPrice && item.price_usd ? item.price_usd / solPrice : 0;
  const commission = calculateCommission(currentSolAmount);
  const { platformFee, sellerAmount } = commission;

  const isCommissionValid = validateCommissionCalculation(
    currentSolAmount,
    platformFee,
    sellerAmount,
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title=""
      showHeader={false}
      className="w-full max-w-md"
    >
      <div className="p-6">
        {isSuccess ? (
          <div className="text-center mb-6">
            <CheckCircle className="h-16 w-16 mx-auto mb-4 text-green-500" />
            <h2 className="text-2xl font-bold mb-2 text-green-600">Purchase Successful! 🎉</h2>
            <p className="text-muted-foreground">
              Congratulations! You now have access to this premium {item.type}
            </p>
            <p className="text-sm text-muted-foreground mt-2">
              Redirecting you to the content...
            </p>
          </div>
        ) : (
          <div className="text-center mb-6">
            <CreditCard className="h-12 w-12 mx-auto mb-4 text-primary" />
            <h2 className="text-2xl font-bold mb-2">Purchase {item.type}</h2>
            <p className="text-muted-foreground">
              Complete your purchase to access this premium {item.type}
            </p>
          </div>
        )}

        {!isSuccess && (
          <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-lg">{item.name}</CardTitle>
            <CardDescription>
              {item.type === 'prompt' ? 'Premium Prompt' : 'Premium Agent'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <hr />
              <div className="flex justify-between font-semibold">
                <span>Amount to pay:</span>
                <span className="font-bold text-base">
                  ${item.price_usd?.toFixed(2) || '0.00'}
                </span>
              </div>
              {priceError && (
                <div className="p-2 bg-red-500/10 border border-red-500/30 rounded text-red-400 text-xs">
                  {priceError}
                </div>
              )}
              {/* {solPrice && item.price_usd && (
                <div className="text-xs text-muted-foreground text-center">
                  ≈ {(item.price_usd / solPrice).toFixed(4)} SOL at current rate
                </div>
              )} */}
            </div>
          </CardContent>
        </Card>
        )}

        {!isSuccess && (
          <>
        {!isCommissionValid && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-950 rounded-lg border border-red-200 dark:border-red-800">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-red-500" />
              <span className="text-sm text-red-700 dark:text-red-300">
                Commission calculation error detected. Please contact support.
              </span>
            </div>
          </div>
        )}

        {!isConnected ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 p-3 bg-blue-50 dark:bg-blue-950 rounded-lg">
              <AlertCircle className="h-5 w-5 text-blue-500" />
              <span className="text-sm">
                Connect your wallet to proceed with the purchase
              </span>
            </div>

            {typeof window !== 'undefined' &&
              !(window as any)?.solana?.isPhantom && (
                <div className="flex items-center gap-2 p-3 bg-amber-50 dark:bg-amber-950 rounded-lg">
                  <AlertCircle className="h-4 w-4 text-amber-500" />
                  <span className="text-sm text-amber-700 dark:text-amber-300">
                    Phantom wallet not detected.
                    <button
                      onClick={() =>
                        window.open('https://phantom.com/', '_blank')
                      }
                      className="underline hover:no-underline ml-1"
                    >
                      Install here
                    </button>
                  </span>
                </div>
              )}

            <Button onClick={connectWallet} className="w-full" size="lg">
              <Wallet className="h-5 w-5 mr-2" />
              Connect Phantom Wallet
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2 p-3 bg-green-50 dark:bg-green-950/30 rounded-lg">
              <CheckCircle className="h-5 w-5 text-green-500" />
              <span className="text-sm">
                Wallet connected: {publicKey?.slice(0, 8)}...
              </span>
            </div>
            <Button
              onClick={handlePurchase}
              disabled={isProcessing || !isCommissionValid}
              className="w-full bg-[#4ECD78]/10 border border-[#4ECD78]/20 hover:bg-[#4ECD78]/20 text-[#4ECD78]"
              size="lg"
            >
              {isProcessing ? (
                <>
                  <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  <CreditCard className="h-5 w-5 mr-2" />
                  <div className="flex items-center gap-2">
                    <span>
                      Purchase for ${item.price_usd?.toFixed(2) || '0.00'}
                    </span>
                  </div>
                </>
              )}
            </Button>
          </div>
        )}

        <div className="mt-6 text-center">
          <Button
            variant="outline"
            className="border border-[#40403F]"
            onClick={onClose}
            disabled={isProcessing}
          >
            Cancel
          </Button>
        </div>
          </>
        )}
      </div>
    </Modal>
  );
};

export default PurchaseModal;

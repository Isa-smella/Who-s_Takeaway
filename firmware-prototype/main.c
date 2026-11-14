/*
 * Two-locker controller using STM32F10x peripheral registers.
 *
 * Hardware connections used by this program:
 *   PA0: Locker 01 MOSFET (Metal-Oxide-Semiconductor Field-Effect Transistor) control.
 *   PA1: Locker 01 feedback input; HIGH is interpreted as OPEN.
 *   PA2: Locker 02 MOSFET control.
 *   PA3: Locker 02 feedback input; HIGH is interpreted as OPEN.
 *   PA9: USART1 TX (transmit) -> HM-10 RXD (receive data).
 *   PA10: USART1 RX (receive) <- HM-10 TXD (transmit data).
 *
 * USART means Universal Synchronous/Asynchronous Receiver/Transmitter.
 * Here USART1 is used for asynchronous serial communication.
 *
 * Command format: an '@' prefix followed by text and CR or LF.
 * CR means Carriage Return ('\r'); LF means Line Feed ('\n').
 * Example command: @OPEN:01\r\n
 */

/* Device register definitions, bit masks, and Cortex-M core support. */
#include "stm32f10x.h"

/* Standard string functions, including strcmp(). */
#include <string.h>

/* Additional delay before a reply; 0 adds no extra delay. */
#define REPLY_DELAY_MS 0

/* Cabinet identifier returned in the @IDENTIFY reply. */
#define CABINET_ID "CABINET_001"


/* =========================================================
 * Blocking delay using the SysTick system timer
 * ========================================================= */

void Delay_ms(uint32_t ms)
{
    /* SysTick must already be configured for a nominal 1 ms period. */
    while (ms--)
    {
        /*
         * Poll COUNTFLAG until the counter has reached zero.
         * Reading CTRL clears COUNTFLAG.
         * This counts timer events, so the delay is approximate:
         * the first flag may already be set when this function starts.
         */
        while ((SysTick->CTRL &
                SysTick_CTRL_COUNTFLAG_Msk) == 0)
        {
        }
    }
}


/* =========================================================
 * Lock control and feedback initialization
 *
 * GPIO: General-Purpose Input/Output.
 * RCC: Reset and Clock Control.
 * APB2: Advanced Peripheral Bus 2.
 * CRL: GPIO configuration register for pins 0 through 7.
 * Each pin uses a 4-bit field: configuration plus input/output mode.
 * ========================================================= */

void Lock_Init(void)
{
    /* Enable the GPIOA peripheral clock before accessing its registers. */
    RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;

    /* Configure PA0 as a general-purpose push-pull output, max speed 2 MHz. */
    GPIOA->CRL &= ~(0xF << 0);
    GPIOA->CRL |=  (0x2 << 0);

    /* BRR (Bit Reset Register): writing 1 to BR0 drives PA0 LOW. */
    GPIOA->BRR = GPIO_BRR_BR0;

    /* Configure PA1 as an input with an internal pull-up or pull-down. */
    GPIOA->CRL &= ~(0xF << 4);
    GPIOA->CRL |=  (0x8 << 4);

    /*
     * Set PA1's output latch to select the pull-up in this input mode.
     * BSRR means Bit Set/Reset Register; PA1 remains an input.
     */
    GPIOA->BSRR = GPIO_BSRR_BS1;

    /* Configure PA2 as a general-purpose push-pull output, max speed 2 MHz. */
    GPIOA->CRL &= ~(0xF << 8);
    GPIOA->CRL |=  (0x2 << 8);

    /* Drive the locker 02 control output LOW initially. */
    GPIOA->BRR = GPIO_BRR_BR2;

    /* Configure PA3 as an input with an internal pull-up or pull-down. */
    GPIOA->CRL &= ~(0xF << 12);
    GPIOA->CRL |=  (0x8 << 12);

    /* Select the internal pull-up for the PA3 feedback input. */
    GPIOA->BSRR = GPIO_BSRR_BS3;
}


/* =========================================================
 * Feedback reading
 *
 * Software interpretation: HIGH = OPEN, LOW = LOCKED.
 * This interpretation must match the connected feedback hardware.
 * IDR means Input Data Register.
 * ========================================================= */

uint8_t Lock1_IsOpen(void)
{
    /* Test PA1 without changing any input register bits. */
    if (GPIOA->IDR & GPIO_IDR_IDR1)
    {
        return 1;
    }

    return 0;
}


uint8_t Lock2_IsOpen(void)
{
    /* Test PA3; return 1 for HIGH and 0 for LOW. */
    if (GPIOA->IDR & GPIO_IDR_IDR3)
    {
        return 1;
    }

    return 0;
}


/* =========================================================
 * Unlock pulses
 *
 * Each function first drives the other control output LOW,
 * then drives its own output HIGH for approximately 500 ms.
 * ========================================================= */

void Lock1_Pulse(void)
{
    /* Turn off the locker 02 control output. */
    GPIOA->BRR = GPIO_BRR_BR2;

    /* Activate the locker 01 control output. */
    GPIOA->BSRR = GPIO_BSRR_BS0;

    Delay_ms(500);

    /* End the locker 01 pulse. */
    GPIOA->BRR = GPIO_BRR_BR0;
}


void Lock2_Pulse(void)
{
    /* Turn off the locker 01 control output. */
    GPIOA->BRR = GPIO_BRR_BR0;

    /* Activate the locker 02 control output. */
    GPIOA->BSRR = GPIO_BSRR_BS2;

    Delay_ms(500);

    /* End the locker 02 pulse. */
    GPIOA->BRR = GPIO_BRR_BR2;
}


/* =========================================================
 * USART1 initialization and blocking transmission
 * ========================================================= */

void USART1_Init(void)
{
    /* Enable clocks for GPIOA, alternate-function I/O, and USART1. */
    RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;
    RCC->APB2ENR |= RCC_APB2ENR_AFIOEN;
    RCC->APB2ENR |= RCC_APB2ENR_USART1EN;

    /*
     * CRH configures pins 8 through 15.
     * PA9: alternate-function push-pull output, max speed 50 MHz.
     * This pin transmits USART1 data; 50 MHz is not the baud rate.
     */
    GPIOA->CRH &= ~(0xF << 4);
    GPIOA->CRH |=  (0xB << 4);

    /* PA10: floating input for incoming USART1 data. */
    GPIOA->CRH &= ~(0xF << 8);
    GPIOA->CRH |=  (0x4 << 8);

    /* Recalculate the SystemCoreClock variable from the clock registers. */
    SystemCoreClockUpdate();

    /*
     * Set the Baud Rate Register for a target rate of 9600 baud.
     * USART1 uses PCLK2 (the APB2 clock), so this expression assumes
     * PCLK2 equals SystemCoreClock. It does not configure that clock.
     */
    USART1->BRR = SystemCoreClock / 9600;

    /*
     * Enable transmitter (TE), receiver (RE), and USART (UE).
     * With the other relevant registers at reset settings, this gives
     * 8 data bits, no parity, and 1 stop bit, without receive interrupts.
     */
    USART1->CR1 =
        USART_CR1_TE |
        USART_CR1_RE |
        USART_CR1_UE;
}


void USART1_SendByte(uint8_t data)
{
    /* TXE: Transmit Data Register Empty; wait until DR can accept a byte. */
    while ((USART1->SR & USART_SR_TXE) == 0)
    {
    }

    /* Write the byte to the Data Register (DR). */
    USART1->DR = data;

    /* TC: Transmission Complete; wait until the full frame is sent. */
    while ((USART1->SR & USART_SR_TC) == 0)
    {
    }
}


void USART1_SendString(const char *str)
{
    /* Send characters until the terminating null character ('\0'). */
    while (*str)
    {
        /* Send the current character, then advance the pointer. */
        USART1_SendByte(*str++);
    }
}


/* =========================================================
 * Open commands
 *
 * If feedback already indicates OPEN, report success without a pulse.
 * Otherwise, pulse the output, wait, and check the feedback again.
 * ========================================================= */

void OpenLocker01(void)
{
    uint8_t success;

    if (Lock1_IsOpen())
    {
        /* An already-open locker is treated as a successful request. */
        success = 1;
    }
    else
    {
        Lock1_Pulse();

        /* Allow additional time for the mechanism and feedback to settle. */
        Delay_ms(500);

        /* Determine success from feedback, not just from sending a pulse. */
        success = Lock1_IsOpen();
    }

    Delay_ms(REPLY_DELAY_MS);

    /* End each response with CRLF so the receiver can identify its end. */
    if (success)
    {
        USART1_SendString("@OPEN:01:OK\r\n");
    }
    else
    {
        USART1_SendString("@OPEN:01:FAIL\r\n");
    }
}


void OpenLocker02(void)
{
    uint8_t success;

    if (Lock2_IsOpen())
    {
        success = 1;
    }
    else
    {
        Lock2_Pulse();

        /* Wait after the pulse before sampling the feedback input. */
        Delay_ms(500);

        success = Lock2_IsOpen();
    }

    Delay_ms(REPLY_DELAY_MS);

    if (success)
    {
        USART1_SendString("@OPEN:02:OK\r\n");
    }
    else
    {
        USART1_SendString("@OPEN:02:FAIL\r\n");
    }
}


/* =========================================================
 * Status commands: read feedback without activating either output
 * ========================================================= */

void StatusLocker01(void)
{
    /* Apply the optional delay before sampling the current state. */
    Delay_ms(REPLY_DELAY_MS);

    if (Lock1_IsOpen())
    {
        USART1_SendString("@STATUS:01:OPEN\r\n");
    }
    else
    {
        USART1_SendString("@STATUS:01:LOCKED\r\n");
    }
}


void StatusLocker02(void)
{
    Delay_ms(REPLY_DELAY_MS);

    if (Lock2_IsOpen())
    {
        USART1_SendString("@STATUS:02:OPEN\r\n");
    }
    else
    {
        USART1_SendString("@STATUS:02:LOCKED\r\n");
    }
}


/* =========================================================
 * Command dispatch
 *
 * cmd must be a null-terminated string with no trailing CR or LF.
 * strcmp() returns 0 when both strings match exactly, including case.
 * Unrecognized commands produce no response in this implementation.
 * ========================================================= */

void ProcessCommand(char *cmd)
{
    if (strcmp(cmd, "@IDENTIFY") == 0)
    {
        Delay_ms(REPLY_DELAY_MS);

        /* Adjacent string literals are joined during compilation. */
        USART1_SendString("@IDENTIFY:" CABINET_ID "\r\n");
    }
    else if (strcmp(cmd, "@OPEN:01") == 0)
    {
        OpenLocker01();
    }
    else if (strcmp(cmd, "@OPEN:02") == 0)
    {
        OpenLocker02();
    }
    else if (strcmp(cmd, "@STATUS:01") == 0)
    {
        StatusLocker01();
    }
    else if (strcmp(cmd, "@STATUS:02") == 0)
    {
        StatusLocker02();
    }
}


/* =========================================================
 * Application entry point and serial command reception
 * ========================================================= */

int main(void)
{
    /* Most recently received byte. */
    uint8_t data;

    /* Holds up to 31 command characters plus the terminating '\0'. */
    char buffer[32];

    /* Position of the next free byte in buffer. */
    uint8_t index = 0;

    /* 0: waiting for '@'; 1: collecting a command. */
    uint8_t receiving = 0;

    /* Update the clock-frequency variable using the existing clock setup. */
    SystemCoreClockUpdate();

    /* Configure a nominal 1 ms SysTick period using the processor clock. */
    SysTick->LOAD =
        SystemCoreClock / 1000 - 1;

    /* Clear the current counter value and COUNTFLAG. */
    SysTick->VAL = 0;

    /*
     * Select the processor clock and start the counter.
     * TICKINT is not enabled: Delay_ms() polls the timer instead.
     */
    SysTick->CTRL =
        SysTick_CTRL_CLKSOURCE_Msk |
        SysTick_CTRL_ENABLE_Msk;

    Lock_Init();
    USART1_Init();

    while (1)
    {
        /* RXNE: Receive Data Register Not Empty; a byte is available. */
        if (USART1->SR & USART_SR_RXNE)
        {
            /* Read the received byte; reading DR clears RXNE. */
            data = USART1->DR;

            /* A new '@' starts a command or restarts an incomplete one. */
            if (data == '@')
            {
                receiving = 1;
                index = 0;

                /* Keep the prefix because ProcessCommand() expects it. */
                buffer[index++] = '@';
            }
            else if (receiving)
            {
                /* Either CR or LF marks the end of the command. */
                if (data == '\r' ||
                    data == '\n')
                {
                    /* Make buffer a valid C string for strcmp(). */
                    buffer[index] = '\0';

                    /* Return to the waiting state before dispatching. */
                    receiving = 0;
                    index = 0;

                    /*
                     * Handle this command synchronously.
                     * This receive loop does not run during blocking
                     * delays or transmissions inside the handler.
                     */
                    ProcessCommand(buffer);
                }
                else
                {
                    /* Reserve the last buffer byte for the null terminator. */
                    if (index < sizeof(buffer) - 1)
                    {
                        buffer[index++] = data;
                    }
                    else
                    {
                        /* Discard an oversized command and wait for a new '@'. */
                        receiving = 0;
                        index = 0;
                    }
                }
            }
            /* Bytes received while waiting are ignored unless they are '@'. */
        }
    }
}
